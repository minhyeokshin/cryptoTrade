"""Read-only historical Python worker comparison; prints JSON, writes no files."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

project = Path(__file__).resolve().parents[1]
root = Path(os.environ['PYTHON_RESEARCH_ROOT']).resolve()
source = root / 'reports/bybit_btcusd_validation/cache/candles.parquet'
data = pd.read_parquet(source, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
sample = data.iloc[:15001].copy()
sample['timestamp'] = pd.to_datetime(sample.timestamp, utc=True)
decision = int(sample.timestamp.iloc[-1].timestamp() * 1000)
if decision % (5 * 60_000):
    raise RuntimeError('sample not on 5m decision grid')
rows = [{**{key: str(item[key]) for key in ('open', 'high', 'low', 'close', 'volume')},
         'end': int(item['timestamp'].timestamp() * 1000)} for _, item in sample.iterrows()]
env = {**os.environ, 'PYTHON_RESEARCH_ROOT': str(root), 'PYTHONDONTWRITEBYTECODE': '1'}
worker = subprocess.run([sys.executable, str(project / 'python/frozen_inference_worker.py')],
                        input=json.dumps({'id': 1, 'candles': rows,
                                          'decisionTimestamp': decision}) + '\n',
                        text=True, capture_output=True, timeout=90, env=env, check=True)
result = json.loads(worker.stdout.strip().splitlines()[-1])
if 'error' in result:
    raise RuntimeError(result['error'])
sys.path.insert(0, str(root / 'scripts/bybit_live'))
sys.path.insert(0, str(root / 'scripts/predictability_bybit_direction_exit_v1'))
from feature_producer import build  # noqa: E402
from run import clean_eval, model_prob  # noqa: E402
model_file = root / 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib'
baseline = json.loads((root / 'reports/bybit_live/frozen_integrity_start.json').read_text())
if hashlib.sha256(model_file.read_bytes()).hexdigest() != baseline['direction_model']:
    raise RuntimeError('model bytes changed')
artifact = joblib.load(model_file)
frame = sample.set_index('timestamp')[['open', 'high', 'low', 'close', 'volume']]
frame.index = frame.index.as_unit('ns')
features = build(frame).iloc[-1].to_numpy()
if not np.isfinite(features).all():
    raise RuntimeError('reference feature not finite')
p = model_prob(artifact['model'], clean_eval(features[None, :], np.array([0]), artifact['transform']))[0]
reference = dict(side=('SHORT', 'NO_ACTION', 'LONG')[int(np.argmax(p))], confidence=float(max(p)))
got = result['prediction']
if os.environ.get('PARITY_EXPORT_JSON') == '1':
    print(json.dumps({'candles': rows, 'decisionTimestamp': decision,
                      'reference': reference, 'modelHash': baseline['direction_model'],
                      'featureSchemaHash': baseline['feature_schema_hash']}, separators=(',', ':')))
    raise SystemExit(0)
print(json.dumps({'sample_decision_utc': sample.timestamp.iloc[-1].isoformat(),
                  'sample_candles': len(sample), 'reference': reference,
                  'worker': {'side': got['side'], 'confidence': got['confidence']},
                  'side_match': reference['side'] == got['side'],
                  'confidence_abs_error': abs(reference['confidence'] - got['confidence']),
                  'model_hash_match': got['modelHash'] == baseline['direction_model'],
                  'feature_schema_hash_match': got['featureSchemaHash'] == baseline['feature_schema_hash']},
                 indent=2))
