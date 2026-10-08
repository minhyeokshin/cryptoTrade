import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FrozenModelClient } from '../dist/inference/model-client.js';

const root = process.env.PYTHON_RESEARCH_ROOT;
const python = process.env.PYTHON_BIN;
if (!root || !python) throw new Error('Explicit research root and Python binary required');
const fixture = JSON.parse(execFileSync(python, ['python/parity_probe.py'], {
  env: { ...process.env, PARITY_EXPORT_JSON: '1' }, encoding: 'utf8', maxBuffer: 20_000_000,
  timeout: 120_000,
}));
const worker = new FrozenModelClient(python, 'python/frozen_inference_worker.py',
  join(root, 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib'));
try {
  await worker.start();
  const got = await worker.predict(fixture.candles, fixture.decisionTimestamp);
  const error = Math.abs(got.confidence - fixture.reference.confidence);
  if (got.side !== fixture.reference.side || error > 1e-12 ||
      got.modelHash !== fixture.modelHash || got.featureSchemaHash !== fixture.featureSchemaHash) {
    throw new Error('Node/Python frozen prediction parity mismatch');
  }
  process.stdout.write(JSON.stringify({ sampleCandles: fixture.candles.length,
    decisionTimestamp: fixture.decisionTimestamp, sideMatch: true,
    confidenceAbsoluteError: error, modelHashMatch: true,
    featureSchemaHashMatch: true }) + '\n');
} finally { worker.stop(); }
