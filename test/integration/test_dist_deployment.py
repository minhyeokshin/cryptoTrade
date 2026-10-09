"""File-only deployment regression checks; never touches /opt, systemd or a DB."""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/deploy-node-dist-stopped.py'
spec = importlib.util.spec_from_file_location('dist_deployment', SCRIPT)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class LegacyPermissionTests(unittest.TestCase):
    def legacy(self):
        uid = deployment.pwd.getpwnam('minhyeok').pw_uid
        gid = deployment.grp.getgrnam('minhyeok').gr_gid
        return {'.': dict(kind='directory', uid=uid, gid=gid, mode=0o775, sha256=None),
                'main.js': dict(kind='file', uid=uid, gid=gid, mode=0o664, sha256='abc')}

    def test_without_explicit_option_legacy_is_rejected(self):
        with self.assertRaises(RuntimeError):
            deployment.validate_old_permissions(self.legacy(), 123)

    def test_exact_full_pattern_accepted_and_audited(self):
        policy = deployment.validate_old_permissions(self.legacy(), 123, True)
        self.assertTrue(policy['legacy_option_used'])
        self.assertEqual(policy['policy'], deployment.LEGACY_POLICY)

    def test_any_single_metadata_deviation_rejected(self):
        for name in ('.', 'main.js'):
            for field in ('uid', 'gid', 'mode'):
                with self.subTest(name=name, field=field):
                    manifest = self.legacy()
                    manifest[name][field] += 1
                    with self.assertRaises(RuntimeError):
                        deployment.validate_old_permissions(manifest, 123, True)

    def test_new_and_existing_paths_receive_safe_modes(self):
        old = self.legacy()
        for name, kind in (('.', 'directory'), ('main.js', 'file'),
                           ('new', 'directory'), ('new/code.js', 'file')):
            self.assertEqual(deployment.new_entry_mode(name, {'kind': kind}, old, True),
                             0o750 if kind == 'directory' else 0o640)

    def test_successful_migration_cannot_reuse_legacy_exception(self):
        manifest = self.legacy()
        for value in manifest.values():
            value.update(uid=0, gid=123, mode=0o750 if value['kind']=='directory' else 0o640)
        deployment.validate_old_permissions(manifest, 123)
        with self.assertRaises(RuntimeError):
            deployment.validate_old_permissions(manifest, 123, True)

    def test_manual_rollback_requires_recorded_legacy_policy(self):
        old = self.legacy()
        record = dict(backup_manifest=old)
        with self.assertRaises(RuntimeError):
            deployment.validate_rollback_permissions(record, 123)
        record['permission_policy'] = deployment.validate_old_permissions(old, 123, True)
        deployment.validate_rollback_permissions(record, 123)
        record['permission_policy']['policy'] = 'arbitrary'
        with self.assertRaises(RuntimeError):
            deployment.validate_rollback_permissions(record, 123)

    def test_backup_and_failed_swap_preserve_original_legacy_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, backup, retired = (root / n for n in ('dist', 'stage', 'backup', 'retired'))
            current.mkdir()
            current.chmod(0o775)
            (current / 'main.js').write_text('original')
            (current / 'main.js').chmod(0o664)
            old = deployment.snapshot(current)
            deployment.validate_old_permissions(old, 123, True)
            deployment.copy_tree(current, backup)
            self.assertEqual(deployment.snapshot(backup), old)
            stage.mkdir(mode=0o750)
            (stage / 'main.js').write_text('new')
            (stage / 'main.js').chmod(0o640)
            with self.assertRaises(deployment.DeploymentFailure) as failure:
                deployment.switch_and_verify(current, stage, retired, backup, old,
                    root / 'prepared.json', lambda: (_ for _ in ()).throw(RuntimeError('post swap')),
                    lambda _e: None, check_stopped=lambda: {})
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_ROLLED_BACK')
            for path in (current, backup, retired):
                self.assertEqual(deployment.snapshot(path), old)


class DistDeploymentTests(unittest.TestCase):
    def test_tree_hash_catches_extra_and_changed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'main.js').write_text('original')
            first = deployment.tree_hash(deployment.snapshot(root))
            (root / 'main.js').write_text('changed')
            second = deployment.tree_hash(deployment.snapshot(root))
            self.assertNotEqual(first, second)
            (root / 'extra.js').write_text('extra')
            self.assertNotEqual(second, deployment.tree_hash(deployment.snapshot(root)))

    def test_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'main.js').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(RuntimeError, 'Non-regular'):
                deployment.snapshot(root)

    def test_backup_preserves_contents_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'dist'
            source.mkdir(mode=0o750)
            (source / 'main.js').write_text('compiled code')
            (source / 'main.js').chmod(0o640)
            backup = Path(directory) / 'backup'
            deployment.copy_tree(source, backup)
            self.assertEqual(deployment.snapshot(source), deployment.snapshot(backup))
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                deployment.copy_tree(source, backup)

    def test_failed_second_rename_restores_old_dist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired = (root / name for name in ('dist', 'stage', 'retired'))
            current.mkdir()
            stage.mkdir()
            (current / 'main.js').write_text('old')
            (stage / 'main.js').write_text('new')
            original_rename = deployment.os.rename

            def rename(source, target):
                if source == stage:
                    raise OSError('injected rename failure')
                original_rename(source, target)

            backup = root / 'backup'
            deployment.copy_tree(current, backup)
            old = deployment.snapshot(current)
            with patch.object(deployment.os, 'rename', side_effect=rename):
                with self.assertRaises(deployment.DeploymentFailure) as failure:
                    deployment.switch_and_verify(current, stage, retired, backup, old,
                        root / 'prepared.json', lambda: self.fail('must not validate'),
                        lambda _evidence: None, check_stopped=lambda: {})
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_ROLLED_BACK')
            self.assertEqual((current / 'main.js').read_text(), 'old')
            self.assertEqual((stage / 'main.js').read_text(), 'new')
            self.assertEqual(deployment.snapshot(retired), old)
            self.assertEqual(deployment.snapshot(backup), old)

    def test_stopped_services_with_no_processes_allowed(self):
        def run(args, **_kwargs):
            if args[0] == 'pgrep':
                return subprocess.CompletedProcess(args, 1, stdout='')
            return subprocess.CompletedProcess(args, 0,
                stdout='LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nRestart=no\n')
        with patch.object(deployment.subprocess, 'run', side_effect=run):
            self.assertEqual(len(deployment.stopped()), 4)

    def test_active_service_prevents_deployment(self):
        with patch.object(deployment.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                stdout='LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nRestart=no\n')):
            with self.assertRaisesRegex(RuntimeError, 'not stopped'):
                deployment.stopped()

    def make_trees(self, root):
        current, stage, retired, backup, source = (root / name for name in
            ('dist', 'stage', 'retired', 'backup', 'source'))
        current.mkdir()
        stage.mkdir()
        (current / 'main.js').write_text('old')
        (current / 'main.js').chmod(0o640)
        (stage / 'main.js').write_text('new')
        (stage / 'main.js').chmod(0o640)
        deployment.copy_tree(current, backup)
        deployment.copy_tree(stage, source)
        return current, stage, retired, backup, source

    def test_post_swap_corruption_rolls_back_without_deleting_old_or_failed_trees(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, source = self.make_trees(root)
            old, expected = deployment.snapshot(current), deployment.snapshot(stage)
            recorded = []

            def verify():
                (current / 'main.js').write_text('corrupt')
                deployment.verify_installed(current, source, expected, deployment.tree_hash(expected))

            with self.assertRaises(deployment.DeploymentFailure) as failure:
                deployment.switch_and_verify(current, stage, retired, backup, old,
                    root / 'prepared.json', verify, recorded.append, check_stopped=lambda: {})
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_ROLLED_BACK')
            self.assertEqual(recorded[0]['deployment_status'], 'FAILED_ROLLED_BACK')
            for path in (current, retired, backup):
                self.assertEqual(deployment.snapshot(path), old)
            failed = Path(recorded[0]['recovery']['failed_tree'])
            self.assertEqual((failed / 'main.js').read_text(), 'corrupt')

    def test_active_service_after_swap_blocks_auto_recovery_and_reports_manual_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, _source = self.make_trees(root)
            old = deployment.snapshot(current)
            checks = iter([{}, RuntimeError('service is active')])

            def check():
                value = next(checks)
                if isinstance(value, Exception):
                    raise value
                return value

            with self.assertRaises(deployment.DeploymentFailure) as failure:
                deployment.switch_and_verify(current, stage, retired, backup, old,
                    root / 'prepared.json', lambda: (_ for _ in ()).throw(ValueError('parity failed')),
                    lambda _evidence: None, check_stopped=check)
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_MANUAL_RECOVERY_REQUIRED')
            self.assertIn('--rollback-record', failure.exception.evidence['rollback']['command_argv'])
            self.assertEqual((current / 'main.js').read_text(), 'new')
            for path in (retired, backup):
                self.assertEqual(deployment.snapshot(path), old)

    def test_recovery_rename_failure_retains_evidence_and_allows_retry_with_absent_dist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, _source = self.make_trees(root)
            old = deployment.snapshot(current)
            original_rename = deployment.os.rename

            def rename(source, target):
                if Path(source).name.startswith('dist.restore.'):
                    raise OSError('restore rename blocked')
                original_rename(source, target)

            with patch.object(deployment.os, 'rename', side_effect=rename):
                with self.assertRaises(deployment.DeploymentFailure) as failure:
                    deployment.switch_and_verify(current, stage, retired, backup, old,
                        root / 'prepared.json', lambda: (_ for _ in ()).throw(ValueError('post check failed')),
                        lambda _evidence: None, check_stopped=lambda: {})
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_MANUAL_RECOVERY_REQUIRED')
            self.assertIn('restore_stage=', failure.exception.evidence['recovery_error'])
            self.assertFalse(current.exists())
            self.assertEqual(deployment.snapshot(retired), old)
            self.assertEqual(deployment.snapshot(backup), old)
            result = deployment.recover_previous(current, retired, backup, old, check_stopped=lambda: {})
            self.assertEqual(result['status'], 'OLD_DIST_RESTORED')
            self.assertEqual(deployment.snapshot(current), old)

    def test_bad_retired_tree_uses_backup_without_overwriting_retired(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, _source = self.make_trees(root)
            old = deployment.snapshot(current)
            deployment.swap_stopped_tree(current, stage, retired)
            (retired / 'main.js').write_text('bad retired')
            deployment.recover_previous(current, retired, backup, old, check_stopped=lambda: {})
            self.assertEqual(deployment.snapshot(current), old)
            self.assertEqual((retired / 'main.js').read_text(), 'bad retired')
            self.assertEqual(deployment.snapshot(backup), old)

    def test_failure_record_io_error_does_not_mask_failed_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, _source = self.make_trees(root)
            old = deployment.snapshot(current)
            with self.assertRaises(deployment.DeploymentFailure) as failure:
                deployment.switch_and_verify(current, stage, retired, backup, old,
                    root / 'prepared.json', lambda: (_ for _ in ()).throw(OSError('complete record failed')),
                    lambda _evidence: (_ for _ in ()).throw(OSError('failure log disk full')),
                    check_stopped=lambda: {})
            self.assertEqual(failure.exception.evidence['deployment_status'], 'FAILED_ROLLED_BACK')
            self.assertIn('disk full', failure.exception.evidence['failure_record_error'])
            self.assertEqual(deployment.snapshot(current), old)

    def test_successful_switch_preserves_old_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current, stage, retired, backup, source = self.make_trees(root)
            old, expected = deployment.snapshot(current), deployment.snapshot(stage)

            def verify():
                deployment.verify_installed(current, source, expected, deployment.tree_hash(expected))
                return 'verified'

            self.assertEqual(deployment.switch_and_verify(current, stage, retired, backup, old,
                root / 'prepared.json', verify, lambda _evidence: self.fail('no failure expected'),
                check_stopped=lambda: {}), 'verified')
            self.assertEqual(deployment.snapshot(current), expected)
            self.assertEqual(deployment.snapshot(retired), old)
            self.assertEqual(deployment.snapshot(backup), old)

    def test_deployment_lock_excludes_other_process_and_releases_on_exception(self):
        code = '''import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('deploy',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
try:
    with m.deployment_lock(Path(sys.argv[2])): pass
except RuntimeError:
    sys.exit(9)
'''
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, '-c', code, str(SCRIPT), directory]
            with self.assertRaisesRegex(ValueError, 'parent error'):
                with deployment.deployment_lock(Path(directory)):
                    self.assertEqual(subprocess.run(command, check=False).returncode, 9)
                    raise ValueError('parent error')
            self.assertEqual(subprocess.run(command, check=False).returncode, 0)


class CommitArtifactBindingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        (self.repo / 'src').mkdir()
        for name, content in {'src/main.ts': 'export const v=1;', 'tsconfig.json': '{}',
                              'package.json': '{}', 'package-lock.json': '{}'}.items():
            (self.repo / name).write_text(content)
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Test',
            '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        self.commit = deployment.git_read(self.repo, 'rev-parse', 'HEAD').decode().strip()
        tree, files = deployment.committed_inputs(self.repo, self.commit)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        (self.dist / 'main.js').write_text('export const v=1;')
        self.digest = deployment.tree_hash(deployment.snapshot(self.dist))
        self.manifest = self.root / 'build-manifest.json'
        self.manifest.write_text(json.dumps(dict(format_version=1, source_commit=self.commit,
            source_git_tree=tree, build_inputs={key: hashlib.sha256(value).hexdigest()
            for key, value in files.items()}, dist_tree_sha256=self.digest)))
        self.pinned = hashlib.sha256(self.manifest.read_bytes()).hexdigest()

    def verify(self, commit=None):
        return deployment.verify_build_binding(self.repo, commit or self.commit,
            self.dist, self.digest, self.manifest, self.pinned)

    def test_committed_input_binding_ignores_dirty_worktree(self):
        (self.repo / 'src/main.ts').write_text('uncommitted change must not be used')
        self.assertEqual(self.verify()['source_commit'], self.commit)
        _, files = deployment.committed_inputs(self.repo, self.commit)
        self.assertEqual(files['src/main.ts'], b'export const v=1;')

    def test_different_commit_rejected(self):
        (self.repo / 'src/main.ts').write_text('export const v=2;')
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Test',
            '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'second'], check=True)
        new_commit = deployment.git_read(self.repo, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
            self.verify(new_commit)

    def test_artifact_mutation_rejected(self):
        (self.dist / 'main.js').write_text('tampered')
        with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
            self.verify()

    def test_manifest_mutation_rejected(self):
        self.manifest.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'manifest hash mismatch'):
            self.verify()

    def test_claimed_commit_without_manifest_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'reviewed build manifest'):
            deployment.verify_build_binding(self.repo, self.commit, self.dist, self.digest, None, None)

    def test_rehashed_manifest_with_wrong_source_inputs_rejected(self):
        manifest = json.loads(self.manifest.read_text())
        manifest['build_inputs']['src/main.ts'] = '0' * 64
        self.manifest.write_text(json.dumps(manifest))
        self.pinned = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
