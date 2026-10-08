"""Export only the immutable inference dependency subset; never copy legacy DB credentials.

The original research source is read-only. Selected function AST/source is copied verbatim into
a separate deployment bundle; the bundle must pass original-model parity before installation.
"""
import argparse
import ast
import hashlib
import json
import shutil
from pathlib import Path

FROZEN_INDICATOR_SHA256 = '7684492479a23ee19002d31ff4dcf3fc7cf9e0f840e1be13e60add8f0fd9a471'


def functions(source: Path, names: tuple[str, ...]) -> list[str]:
    content = source.read_text()
    tree = ast.parse(content, filename=str(source))
    by_name = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    if set(names) - by_name.keys():
        raise RuntimeError(f"Frozen function missing: {sorted(set(names) - by_name.keys())}")
    lines = content.splitlines(keepends=True)
    return [''.join(lines[by_name[name].lineno - 1:by_name[name].end_lineno]) for name in names]


def constants(source: Path, names: tuple[str, ...]) -> dict:
    tree = ast.parse(source.read_text(), filename=str(source))
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in names:
                found[node.targets[0].id] = ast.literal_eval(node.value)
    if set(found) != set(names):
        raise RuntimeError('Frozen feature constants missing')
    return found


def copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--research-root', type=Path, required=True)
    parser.add_argument('--dest', type=Path, required=True)
    args = parser.parse_args()
    root = args.research_root.resolve(strict=True)
    dest = args.dest.resolve()
    if dest == root or root in dest.parents or dest in root.parents:
        raise RuntimeError('Bundle destination must be separate from frozen research')
    if dest.exists() and any(dest.iterdir()):
        raise RuntimeError('Bundle destination must be empty')
    dest.mkdir(parents=True, exist_ok=True)

    original_feature = root / 'scripts/bybit_live/feature_producer.py'
    original_data = root / 'scripts/predictability_bybit_v1/data.py'
    original_common = root / 'scripts/predictability_bybit_v1/common.py'
    original_indicator = root / 'generate_features.py'
    original_run = root / 'scripts/predictability_bybit_direction_exit_v1/run.py'
    original_baseline = root / 'reports/bybit_live/frozen_integrity_start.json'
    original_model = root / 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib'

    # Keep frozen feature/model functions verbatim; omit all DB client/configuration code.
    selected = functions(original_indicator,
        ('rma', 'calculate_rsi', 'ema', 'calculate_atr', 'calculate_features'))
    (dest / 'generate_features.py').write_text('import numpy as np\nimport pandas as pd\n\n' + '\n\n'.join(selected) + '\n')
    segmented = functions(original_data, ('segmented_features',))[0]
    safe_data = dest / 'scripts/predictability_bybit_v1/data.py'
    safe_data.parent.mkdir(parents=True, exist_ok=True)
    safe_data.write_text('import sys\nfrom pathlib import Path\nimport numpy as np\nimport pandas as pd\n'
        'sys.path.insert(0, str(Path(__file__).resolve().parents[2]))\n'
        'from common import BASE\nfrom generate_features import calculate_features\n\n'
        + segmented + '\n')
    frozen_constants = constants(original_common, ('BASE', 'WINDOWS'))
    (safe_data.parent / 'common.py').write_text(
        ''.join(f'{name} = {frozen_constants[name]!r}\n' for name in ('BASE', 'WINDOWS')))
    copy(original_feature, dest / 'scripts/bybit_live/feature_producer.py')
    copy(original_run, dest / 'scripts/predictability_bybit_direction_exit_v1/run.py')
    copy(original_baseline, dest / 'reports/bybit_live/frozen_integrity_start.json')
    copy(original_model, dest / 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib')

    baseline = json.loads(original_baseline.read_text())
    model_hash = hashlib.sha256(original_model.read_bytes()).hexdigest()
    checks = {original_model: baseline['direction_model'],
        original_feature: baseline['feature_builder'],
        original_data: baseline['frozen_feature_source'],
        original_indicator: FROZEN_INDICATOR_SHA256}
    if any(hashlib.sha256(path.read_bytes()).hexdigest() != expected for path, expected in checks.items()):
        raise RuntimeError('Original frozen dependency hash mismatch')
    forbidden = ('db_config', 'password', 'psycopg2', 'api_key', 'api_secret')
    for file in dest.rglob('*.py'):
        if any(token in file.read_text().lower() for token in forbidden):
            raise RuntimeError(f'Unsafe module in frozen runtime bundle: {file.relative_to(dest)}')
    print(json.dumps({'model_sha256': model_hash,
        'feature_schema_hash': baseline['feature_schema_hash'],
        'source_functions': len(selected) + 1, 'bundle_root': str(dest)}, sort_keys=True))


if __name__ == '__main__':
    main()
