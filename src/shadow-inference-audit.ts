import { userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FROZEN } from './config/frozen.js';
import { poolForRole } from './db/postgres.js';
import { verifyShadowDbPreflight } from './db/shadow-preflight.js';
import { MarketReadRepository } from './db/repositories/market-read.js';
import { auditProducerSource } from './market/source-audit.js';
import { FrozenModelClient } from './inference/model-client.js';
import { validateShadowRuntimeApproval } from './shadow/launch.js';

if (userInfo().username !== 'bybit_shadow') throw new Error('bybit_shadow OS user required');
const python = process.env.PYTHON_EXECUTABLE;
const root = process.env.PYTHON_RESEARCH_ROOT;
const approval = process.env.SHADOW_POLICY_APPROVAL_PATH;
if (!python || !root || !approval || ![python, root, approval].every(isAbsolute)) {
  throw new Error('Absolute frozen inference/runtime policy paths required');
}
validateShadowRuntimeApproval(JSON.parse(await readFile(approval, 'utf8')) as unknown);
const pool = poolForRole('bybit_shadow');
try {
  await verifyShadowDbPreflight(pool);
  const source = await auditProducerSource(pool);
  if (!source.sourceFresh || source.latestCandleTimestamp === null ||
      source.latestCandleTimestamp % FROZEN.horizonMs !== 0) {
    throw new Error('Await a fresh finalized Node 5m decision');
  }
  const market = new MarketReadRepository(pool);
  const candles = await market.warmupBefore(Date.now(), 12_000);
  if (candles.length !== 12_000 || candles.at(-1)?.end !== source.latestCandleTimestamp ||
      candles.some((candle, i) => i > 0 && candle.end !== candles[i - 1]!.end + 60_000)) {
    throw new Error('Full causal frozen feature warmup unavailable');
  }
  const model = new FrozenModelClient(python,
    resolve(process.cwd(), 'python/frozen_inference_worker.py'),
    resolve(root, 'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib'));
  try {
    await model.start();
    const prediction = await model.predict(candles, source.latestCandleTimestamp);
    if (prediction.featureCutoff !== prediction.decisionTimestamp ||
        prediction.modelHash !== FROZEN.directionModelHash ||
        prediction.featureSchemaHash !== FROZEN.featureSchemaHash) {
      throw new Error('Noncausal or nonfrozen inference response');
    }
    process.stdout.write(`${JSON.stringify({ status: 'CAUSAL_INFERENCE_PASS',
      decisionTimestamp: new Date(prediction.decisionTimestamp).toISOString(),
      featureCutoff: new Date(prediction.featureCutoff).toISOString(),
      side: prediction.side, confidence: prediction.confidence,
      modelHash: prediction.modelHash, featureSchemaHash: prediction.featureSchemaHash })}\n`);
  } finally { model.stop(); }
} finally { await pool.end(); }
