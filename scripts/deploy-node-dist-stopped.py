"""Operator-only dist replacement. No services, database, approvals or models are changed.

--inspect is unprivileged. Deployment requires root and verifies the caller's
prebuilt tree hash. Existing dist is backed up and retained after replacement.
"""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import grp
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

RUNTIME = Path('/opt/cryptoTrade-runtime')
UNITS = ('bybit-producer.service', 'bybit-node-producer.service',
         'bybit-shadow.service', 'bybit-node-shadow.service')
BUILD_INPUTS = ('src', 'tsconfig.json', 'package.json', 'package-lock.json')
LEGACY_POLICY = 'minhyeok-0775-0664-v1'


def validate_old_permissions(manifest, gid, legacy=False):
    """Explicit legacy exception, checked on every entry including the root."""
    uid = pwd.getpwnam('minhyeok').pw_uid if legacy else 0
    owner_gid = grp.getgrnam('minhyeok').gr_gid if legacy else gid
    if not manifest or manifest.get('.', {}).get('kind') != 'directory':
        raise RuntimeError('Missing dist root manifest')
    for name, entry in manifest.items():
        kind = entry['kind']
        valid_mode = (entry['mode'] == (0o775 if kind == 'directory' else 0o664)
                      if legacy else not entry['mode'] & 0o022)
        if (kind not in ('file', 'directory') or entry['uid'] != uid or
                entry['gid'] != owner_gid or not valid_mode):
            raise RuntimeError(f'Unexpected old dist ownership/mode: {name}')
    return dict(policy=LEGACY_POLICY if legacy else 'strict', legacy_option_used=legacy,
                uid=uid, gid=owner_gid)


def new_entry_mode(name, entry, old, legacy):
    if legacy:
        return 0o750 if entry['kind'] == 'directory' else 0o640
    previous = old.get(name)
    if previous and previous['kind'] == entry['kind']:
        return previous['mode']
    return old['.']['mode'] if entry['kind'] == 'directory' else old['main.js']['mode']


def validate_rollback_permissions(record, gid):
    policy = record.get('permission_policy', {})
    legacy = policy.get('legacy_option_used', False)
    if type(legacy) is not bool or (legacy and policy.get('policy') != LEGACY_POLICY):
        raise RuntimeError('Invalid legacy rollback authorization')
    verified = validate_old_permissions(record['backup_manifest'], gid, legacy)
    if policy and policy != verified:
        raise RuntimeError('Rollback permission policy mismatch')


class DeploymentFailure(RuntimeError):
    def __init__(self, evidence):
        super().__init__(evidence['error'])
        self.evidence = evidence


@contextmanager
def deployment_lock(runtime):
    """Cooperative, host-local lock held through verification and error recovery."""
    fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Concurrent dist deployment blocked; no changes made') from error
        yield
    finally:
        os.close(fd)


def git_read(repo, *args):
    # Read objects without replacement refs, hooks, global configuration or network.
    return subprocess.run(['git', '--no-replace-objects', '-c', f'safe.directory={repo}',
        '-c', 'core.hooksPath=/dev/null', '-C', str(repo), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_CONFIG_GLOBAL': '/dev/null'}).stdout


def committed_inputs(repo, commit):
    if not commit or not re.fullmatch('[0-9a-f]{40}', commit):
        raise RuntimeError('Full reviewed source commit required')
    resolved = git_read(repo, 'rev-parse', '--verify', f'{commit}^{{commit}}').decode().strip()
    if resolved != commit:
        raise RuntimeError('Input is not the exact source commit')
    files = {}
    entries = git_read(repo, 'ls-tree', '-rz', '--full-tree', commit, '--', *BUILD_INPUTS)
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        header, raw_path = entry.split(b'\t', 1)
        mode, kind, blob = header.decode().split()
        name = raw_path.decode()
        if kind != 'blob' or mode not in ('100644', '100755') or Path(name).is_absolute() or '..' in Path(name).parts:
            raise RuntimeError('Unsupported committed build input')
        files[name] = git_read(repo, 'cat-file', 'blob', blob)
    if any(name not in files for name in BUILD_INPUTS[1:]) or 'src/main.ts' not in files:
        raise RuntimeError('Incomplete committed build inputs')
    tree = git_read(repo, 'rev-parse', f'{commit}^{{tree}}').decode().strip()
    return tree, files


def prepare_build(repo, commit):
    """Export immutable Git objects; run the installed compiler as a non-root user."""
    if os.geteuid() == 0:
        raise RuntimeError('Prepare the build as an unprivileged user, never as root')
    tree, files = committed_inputs(repo, commit)
    compiler = repo / 'node_modules/typescript/bin/tsc'
    compiler_package = repo / 'node_modules/typescript/package.json'
    lock = json.loads(files['package-lock.json'])
    compiler_version = json.loads(compiler_package.read_text())['version']
    if lock['packages']['node_modules/typescript']['version'] != compiler_version:
        raise RuntimeError('Installed TypeScript version differs from committed lockfile')
    root = Path(tempfile.mkdtemp(prefix=f'cryptoTrade-build-{commit[:7]}.'))
    source = root / 'source'
    for name, content in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (source / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    dist = root / 'dist'
    subprocess.run(['node', str(compiler), '-p', str(source / 'tsconfig.json'),
                    '--outDir', str(dist)], cwd=source, check=True)
    manifest = dict(format_version=1, source_commit=commit, source_git_tree=tree,
        build_inputs={name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        dist_tree_sha256=tree_hash(snapshot(dist)),
        compiler_version=compiler_version,
        compiler_tree_sha256=tree_hash(snapshot(repo / 'node_modules/typescript')),
        node_version=subprocess.check_output(['node', '--version'], text=True).strip())
    manifest_path = root / 'build-manifest.json'
    with manifest_path.open('x') as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write('\n')
    return dict(source_dist=str(dist), build_manifest=str(manifest_path),
        expected_manifest_sha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        expected_tree=manifest['dist_tree_sha256'], commit=commit)


def verify_build_binding(repo, commit, source, expected_tree, manifest_path, expected_manifest):
    if not manifest_path or not expected_manifest or not re.fullmatch('[0-9a-f]{64}', expected_manifest):
        raise RuntimeError('A reviewed build manifest and its pinned SHA256 are required')
    raw = manifest_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_manifest:
        raise RuntimeError('Build manifest hash mismatch')
    manifest = json.loads(raw)
    tree, files = committed_inputs(repo, commit)
    inputs = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    if (manifest.get('format_version') != 1 or manifest.get('source_commit') != commit or
            manifest.get('source_git_tree') != tree or manifest.get('build_inputs') != inputs or
            manifest.get('dist_tree_sha256') != expected_tree or
            tree_hash(snapshot(source)) != expected_tree):
        raise RuntimeError('Commit/build artifact binding mismatch')
    return dict(source_commit=commit, source_git_tree=tree, manifest_sha256=expected_manifest,
                dist_tree_sha256=expected_tree)


def snapshot(root):
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            kind, digest = 'directory', None
        elif stat.S_ISREG(info.st_mode):
            kind = 'file'
            with path.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        else:
            raise RuntimeError(f'Non-regular runtime entry: {path}')
        if any(name.startswith('system.posix_acl_') for name in os.listxattr(path)):
            raise RuntimeError(f'Extended ACL requires separate permission review: {path}')
        result[str(path.relative_to(root))] = dict(
            kind=kind, sha256=digest, uid=info.st_uid, gid=info.st_gid,
            mode=stat.S_IMODE(info.st_mode))
    return result


def tree_hash(manifest):
    content = [[key, value['kind'], value['sha256']]
               for key, value in sorted(manifest.items())]
    return hashlib.sha256(json.dumps(content, separators=(',', ':')).encode()).hexdigest()


def stopped():
    evidence = {}
    for unit in UNITS:
        proc = subprocess.run(['systemctl', 'show', unit, '-p', 'LoadState',
                               '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
                               '-p', 'Restart'], check=True, capture_output=True, text=True)
        values = dict(line.split('=', 1) for line in proc.stdout.splitlines() if '=' in line)
        if values.get('ActiveState') not in ('inactive', 'failed') or values.get('MainPID') != '0':
            raise RuntimeError(f'Service is not stopped: {unit}: {values}')
        if unit == 'bybit-node-producer.service' and (
                values.get('LoadState') != 'loaded' or values.get('Restart') != 'no'):
            raise RuntimeError('Node Producer must be loaded with Restart=no')
        evidence[unit] = values
    processes = subprocess.run(['pgrep', '-af',
        'blind_capture_daemon.py|shadow_daemon.py|'
        '/opt/cryptoTrade-runtime/dist/main.js|/opt/cryptoTrade-shadow/dist/main.js'],
        capture_output=True, text=True)
    if processes.returncode != 1:
        raise RuntimeError('Producer/Shadow process remains or process check failed: ' + processes.stdout)
    return evidence


def copy_tree(source, destination):
    if destination.exists() or destination.is_symlink():
        raise RuntimeError(f'Destination already exists: {destination}')
    subprocess.run(['cp', '-a', '--', str(source), str(destination)], check=True)


def swap_stopped_tree(current, stage, retired):
    if retired.exists() or retired.is_symlink():
        raise RuntimeError('Retired tree path already exists')
    os.rename(current, retired)
    os.rename(stage, current)


def recover_previous(current, retired, backup, old, check_stopped=stopped):
    """Restore a verified copy; never consume backup/retired or delete failed files."""
    check_stopped()
    try:
        if current.exists() and not current.is_symlink() and snapshot(current) == old:
            return dict(status='ORIGINAL_INTACT')
    except (OSError, RuntimeError):
        pass  # Preserve an invalid current tree by renaming it, never traversing it to repair.
    verified = None
    for candidate in (retired, backup):
        try:
            if snapshot(candidate) == old:
                verified = candidate
                break
        except (OSError, RuntimeError):
            continue
    if verified is None:
        raise RuntimeError('No intact backup/retired tree; manual recovery required')
    tag = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    restore_stage = current.parent / f'dist.restore.{tag}'
    failed_tree = current.parent / f'dist.failed.{tag}'
    copy_tree(verified, restore_stage)
    if snapshot(restore_stage) != old:
        raise RuntimeError(f'Restore copy mismatch; retained at {restore_stage}')
    sync_tree(restore_stage)
    check_stopped()  # Recheck immediately before changing the operating path again.
    try:
        if current.exists() or current.is_symlink():
            os.rename(current, failed_tree)
        os.rename(restore_stage, current)
        if snapshot(current) != old:
            raise RuntimeError('Restored dist verification failed')
        sync_tree(current)
        sync_directory(current.parent)
        after = check_stopped()
    except BaseException as error:
        raise RuntimeError(f'Recovery incomplete: {error}; source={verified}; '
                           f'restore_stage={restore_stage}; failed_tree={failed_tree}') from error
    return dict(status='OLD_DIST_RESTORED', source=str(verified),
                failed_tree=str(failed_tree) if failed_tree.exists() else None,
                stopped_services=after)


def manual_recovery(record_path):
    return dict(rollback_record=str(record_path),
        instructions='Keep services stopped. Review the failure and backup manifests. '
        'If services are active or unreadable, restore the stopped-state prerequisite first. '
        'Then run the root-owned-record rollback command; do not delete retained trees.',
        command_argv=['sudo', '/usr/bin/python3', str(Path(__file__).resolve()),
                      '--rollback-record', str(record_path)])


def switch_and_verify(current, stage, retired, backup, old, prepared,
                      verify, on_failure, check_stopped=stopped):
    """All post-swap validation and completion-record errors use one failure path."""
    check_stopped()
    if snapshot(current) != old:
        raise RuntimeError('Operating dist changed during preparation')
    try:
        swap_stopped_tree(current, stage, retired)
        return verify()
    except BaseException as cause:
        evidence = dict(deployment_status='FAILED', error=f'{type(cause).__name__}: {cause}',
                        rollback=manual_recovery(prepared), backup_path=str(backup),
                        retired_path=str(retired), restart_safety='FAIL', shadow_ready=False)
        try:
            evidence['recovery'] = recover_previous(current, retired, backup, old, check_stopped)
            evidence['deployment_status'] = 'FAILED_ROLLED_BACK'
        except BaseException as error:
            evidence['deployment_status'] = 'FAILED_MANUAL_RECOVERY_REQUIRED'
            evidence['recovery_error'] = f'{type(error).__name__}: {error}'
        try:
            on_failure(evidence)
        except BaseException as error:
            evidence['failure_record_error'] = f'{type(error).__name__}: {error}'
        # Even successful rollback is a FAILED deployment and must exit nonzero.
        raise DeploymentFailure(evidence) from cause


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_tree(root):
    for path in [*root.rglob('*'), root]:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def verify_installed(current, source, expected_manifest, expected_hash):
    if snapshot(current) != expected_manifest or tree_hash(snapshot(current)) != expected_hash:
        raise RuntimeError('Post-deployment content/metadata parity failed')
    subprocess.run(['diff', '--no-dereference', '-qr', '--', str(source), str(current)], check=True)


def write_record(path, record, gid):
    with path.open('x', encoding='utf8') as handle:
        os.fchmod(handle.fileno(), 0o640)
        os.fchown(handle.fileno(), 0, gid)
        json.dump(record, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    sync_directory(path.parent)


def rollback_from_record(record_path, gid):
    info = record_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Rollback record must be root-owned and not writable by others')
    record = json.loads(record_path.read_text())
    backup, retired = Path(record['backup_path']), Path(record['retired_path'])
    if (backup.parent != RUNTIME or not backup.name.startswith('dist.backup.') or
            retired.parent != RUNTIME or not retired.name.startswith('dist.retired.')):
        raise RuntimeError('Rollback path outside dedicated runtime')
    old = record['backup_manifest']
    if tree_hash(old) != record['backup_tree_sha256']:
        raise RuntimeError('Invalid rollback manifest')
    validate_rollback_permissions(record, gid)
    try:
        result = recover_previous(RUNTIME / 'dist', retired, backup, old)
    except BaseException as error:
        raise DeploymentFailure(dict(deployment_status='FAILED_MANUAL_RECOVERY_REQUIRED',
            error=f'{type(error).__name__}: {error}', rollback=manual_recovery(record_path))) from error
    tag = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    write_record(RUNTIME / f'dist-rollback.{tag}.json', result, gid)
    print(json.dumps(dict(rollback_status='PASS', deployment_status='NOT_DEPLOYED', recovery=result)))


def deploy(args, gid):
    source, expected, commit = args.source_dist, args.expected_tree, args.commit
    if not expected or not re.fullmatch('[0-9a-f]{64}', expected):
        raise RuntimeError('Expected complete source tree SHA256 required')
    binding = verify_build_binding(args.repository, commit, source, expected,
                                   args.build_manifest, args.expected_manifest)
    source_manifest = snapshot(source)
    if source_manifest.get('main.js', {}).get('kind') != 'file':
        raise RuntimeError('Reviewed source tree has no regular main.js')
    if tree_hash(source_manifest) != expected:
        raise RuntimeError('Source build differs from reviewed tree')
    before_services = stopped()
    current = RUNTIME / 'dist'
    old = snapshot(current)
    permission_policy = validate_old_permissions(old, gid, args.legacy_permission_migration)
    if old.get('main.js', {}).get('kind') != 'file':
        raise RuntimeError('Old main.js required as permission reference')
    tag = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = RUNTIME / f'dist.backup.{tag}'
    stage = RUNTIME / f'dist.stage.{tag}'
    retired = RUNTIME / f'dist.retired.{tag}'
    prepared = RUNTIME / f'dist-deploy.{tag}.prepared.json'
    copy_tree(current, backup)
    if snapshot(backup) != old:
        raise RuntimeError('Backup content/ownership/mode verification failed')
    sync_tree(backup)
    # Save rollback evidence before staging or any operating-path rename.
    record = dict(commit=commit, backup_path=str(backup), backup_tree_sha256=tree_hash(old),
                  backup_manifest=old, staged_tree_sha256=expected,
                  retired_path=str(retired), before_services=before_services, build_binding=binding,
                  permission_policy=permission_policy)
    write_record(prepared, record, gid)
    print(json.dumps(dict(deployment_status='PREPARED', backup_path=str(backup), backup_verified=True,
                          rollback_record=str(prepared))), flush=True)
    copy_tree(source, stage)
    staged = snapshot(stage)
    if tree_hash(staged) != expected:
        raise RuntimeError('Staged copy differs from reviewed source')
    for name, entry in staged.items():
        path = stage / name
        mode_bits = new_entry_mode(name, entry, old, args.legacy_permission_migration)
        os.chown(path, 0, gid)
        os.chmod(path, mode_bits)
        entry.update(uid=0, gid=gid, mode=mode_bits)
    if snapshot(stage) != staged:
        raise RuntimeError('Staged owner/mode parity failed')
    sync_tree(stage)

    def verify():
        verify_installed(current, source, staged, expected)
        after_services = stopped()
        sync_directory(RUNTIME)
        result = dict(record, deployment_status='SUCCESS', deployed_commit=commit,
            dist_tree_parity='PASS', diff_exit_code=0, owner_mode_parity='PASS',
            after_services=after_services, rollback_record=str(prepared),
            restart_safety='FAIL', shadow_ready=False)
        write_record(RUNTIME / f'dist-deploy.{tag}.complete.json', result, gid)
        return result

    def record_failure(failure):
        failure['permission_policy'] = permission_policy
        write_record(RUNTIME / f'dist-deploy.{tag}.failed.json', failure, gid)

    result = switch_and_verify(current, stage, retired, backup, old, prepared, verify, record_failure)
    print(json.dumps({key: value for key, value in result.items() if key != 'backup_manifest'}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', type=Path)
    mode.add_argument('--prepare-build', action='store_true')
    mode.add_argument('--source-dist', type=Path)
    mode.add_argument('--rollback-record', type=Path)
    parser.add_argument('--expected-tree')
    parser.add_argument('--commit')
    parser.add_argument('--build-manifest', type=Path)
    parser.add_argument('--expected-manifest')
    parser.add_argument('--legacy-permission-migration', action='store_true',
        help='One-time exact minhyeok:minhyeok dirs=0775 files=0664 migration; never repairs old dist')
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    args.repository = args.repository.resolve(strict=True)
    if args.inspect:
        manifest = snapshot(args.inspect)
        print(json.dumps(dict(tree_sha256=tree_hash(manifest),
                              files=sum(v['kind'] == 'file' for v in manifest.values()),
                              manifest=manifest)))
        return
    if args.prepare_build:
        print(json.dumps(prepare_build(args.repository, args.commit), indent=2))
        return
    if os.geteuid() != 0:
        raise RuntimeError('Root deployment authority required; no alternate privilege route')
    os.umask(0o077)
    gid = grp.getgrnam('bybit_producer').gr_gid
    info = RUNTIME.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or info.st_mode & 0o022:
        raise RuntimeError('Unexpected operating runtime ownership/permissions')
    if any(name.startswith('system.posix_acl_') for name in os.listxattr(RUNTIME)):
        raise RuntimeError('Runtime directory ACL requires separate review')
    with deployment_lock(RUNTIME):
        if args.rollback_record:
            rollback_from_record(args.rollback_record, gid)
        else:
            deploy(args, gid)


if __name__ == '__main__':
    try:
        main()
    except DeploymentFailure as error:
        print(json.dumps(error.evidence, indent=2), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(json.dumps(dict(deployment_status='FAILED',
                              error=f'{type(error).__name__}: {error}')), file=sys.stderr)
        sys.exit(1)
