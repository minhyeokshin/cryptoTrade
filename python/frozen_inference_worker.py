"""Long-lived, local stdin/stdout RPC to the original frozen Direction model.

No training, Bybit client, DB client, private API, orders or network calls.
Model and feature code are loaded from PYTHON_RESEARCH_ROOT read-only.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(os.environ['PYTHON_RESEARCH_ROOT']).resolve()
if not (ROOT / 'reports/bybit_live/frozen_integrity_start.json').is_file():
    raise RuntimeError('frozen research root unavailable')
sys.path.insert(0, str(ROOT / 'scripts/bybit_live'))
sys.path.insert(0, str(ROOT / 'scripts/predictability_bybit_direction_exit_v1'))
from feature_producer import FEATURE_ORDER, build, warmup_dependency  # noqa: E402
from run import clean_eval, model_prob  # noqa: E402

baseline = json.loads((ROOT / 'reports/bybit_live/frozen_integrity_start.json').read_text())
model_file = ROOT / 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib'
if hashlib.sha256(model_file.read_bytes()).hexdigest() != baseline['direction_model']:
    raise RuntimeError('frozen model hash mismatch')
artifact = joblib.load(model_file)
if artifact['feature_order'] != FEATURE_ORDER:
    raise RuntimeError('frozen feature order mismatch')
minimum = warmup_dependency()['maximum_finite_rolling_minutes']


def predict(request):
    candles = request['candles']
    decision = int(request['decisionTimestamp'])
    if len(candles) < minimum or int(candles[-1]['end']) != decision:
        raise ValueError('incomplete causal warmup/decision candle')
    frame = pd.DataFrame([{k: float(row[k]) for k in ('open', 'high', 'low', 'close', 'volume')}
                          for row in candles],
                         index=pd.to_datetime([row['end'] for row in candles], unit='ms', utc=True).as_unit('ns'))
    if frame.index.has_duplicates or not frame.index.is_monotonic_increasing or not frame.index.to_series().diff().iloc[1:].eq(pd.Timedelta(minutes=1)).all():
        raise ValueError('noncontiguous candle history')
    if frame.index[-1].value // 1_000_000 != decision:
        raise ValueError('future or missing decision input')
    feature = build(frame).iloc[-1].to_numpy()
    if not np.isfinite(feature).all():
        raise ValueError('frozen feature not finite')
    probabilities = model_prob(artifact['model'], clean_eval(feature[None, :], np.array([0]), artifact['transform']))[0]
    i = int(np.argmax(probabilities))
    side = ('SHORT', 'NO_ACTION', 'LONG')[i]
    confidence = float(max(probabilities))
    flip = confidence >= .55 and side != 'NO_ACTION'
    return dict(decisionTimestamp=decision, featureCutoff=decision, side=side,
                confidence=confidence, actionable=flip and (decision // 60_000) % 5 == 0,
                flipActionable=flip, modelHash=baseline['direction_model'],
                featureSchemaHash=baseline['feature_schema_hash'])


for line in sys.stdin:
    try:
        message = json.loads(line)
        result = {'id': message['id'], 'prediction': predict(message)}
    except Exception as error:
        result = {'id': message.get('id') if 'message' in locals() else -1,
                  'error': f'{type(error).__name__}: {error}'}
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    sys.stdout.flush()
