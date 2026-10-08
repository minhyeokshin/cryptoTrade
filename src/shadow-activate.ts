import { userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { FROZEN } from './config/frozen.js';
import { poolForRole } from './db/postgres.js';
import { verifyShadowDbPreflight } from './db/shadow-preflight.js';
import { MarketReadRepository } from './db/repositories/market-read.js';
import { ShadowStateStore } from './shadow/state-store.js';
import { ShadowEngine } from './shadow/shadow-engine.js';
import { parseShadowLaunchConfig, validateShadowRuntimeApproval } from './shadow/launch.js';
import { readShadowOperationalGate, validateShadowOperationalGate } from './shadow/operational-gate.js';
import { auditProducerSource } from './market/source-audit.js';
import { publicContractSpec } from './market/bybit-rest.js';

function serviceState(...args: string[]): string {
  const result = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 5000 });
  if (result.error || !result.stdout?.trim()) throw new Error('Service state unavailable');
  return result.stdout.trim();
}

if (userInfo().username !== 'bybit_shadow') throw new Error('bybit_shadow OS user required');
const config = parseShadowLaunchConfig(process.env);
validateShadowRuntimeApproval(
  JSON.parse(await readFile(config.policyApprovalPath, 'utf8')) as unknown);
if (serviceState('is-active', 'bybit-node-producer.service') !== 'active' ||
    serviceState('is-active', 'bybit-producer.service') !== 'inactive' ||
    serviceState('is-enabled', 'bybit-producer.service') !== 'disabled') {
  throw new Error('Node-only canonical producer service state not verified');
}
const pool = poolForRole('bybit_shadow');
try {
  await verifyShadowDbPreflight(pool);
  const source = await auditProducerSource(pool);
  if (!source.sourceFresh || !source.epochId) throw new Error('Node source is not freshly reconciled');
  const now = Date.now();
  validateShadowOperationalGate(readShadowOperationalGate(), config.activationId, source.epochId, now);
  const market = new MarketReadRepository(pool);
  const candles = await market.warmupBefore(now, 11_999);
  if (candles.length !== 11_999 || candles.at(-1)?.end !== source.latestCandleTimestamp ||
      candles.some((candle, i) => i > 0 && candle.end !== candles[i - 1]!.end + 60_000)) {
    throw new Error('Full contiguous frozen warmup unavailable; no activation created');
  }
  const spec = await publicContractSpec();
  if (spec.lotSize !== config.lotSize) throw new Error('Inverse contract lot size mismatch');
  const mark = Number(candles.at(-1)!.close);
  const activationAt = Math.floor(Date.now() / FROZEN.horizonMs) * FROZEN.horizonMs + FROZEN.horizonMs;
  if (activationAt - Date.now() < 90_000) {
    throw new Error('Insufficient time to start Shadow before first causal 5m decision');
  }
  const store = new ShadowStateStore(pool);
  const result = await store.activate(config.activationId,
    new ShadowEngine(activationAt, mark, config.lotSize).state);
  if (result !== 'COMMITTED') throw new Error('Activation already exists; no duplicate activation');
  process.stdout.write(`${JSON.stringify({ activationId: config.activationId,
    activationTimestamp: new Date(activationAt).toISOString(), producerEpochId: source.epochId,
    modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash })}\n`);
} finally { await pool.end(); }
