import { assertFrozenEnvironment } from './config/frozen.js';
import { makeApp } from './app.js';
import { MarketRuntime } from './market/market-runtime.js';
import type { RuntimeView } from './api/routes/health.js';
import { launchRestoredShadow } from './shadow/launch.js';
import { shadowDbView } from './api/shadow-db-view.js';
import { poolForRole, verifyPeerRole } from './db/postgres.js';
import { MarketReadRepository } from './db/repositories/market-read.js';
import { ShadowStateStore } from './shadow/state-store.js';
import { userInfo } from 'node:os';
import { assertProducerCutover } from './market/producer-cutover-guard.js';
import { ProducerLease } from './db/producer-lease.js';
import { MarketRepository } from './db/repositories/market.js';
import { randomUUID } from 'node:crypto';
import { verifyProducerDbPreflight } from './db/producer-preflight.js';
import { approvedStartupMode, loadNewEpochApproval } from './market/new-live-epoch-approval.js';

assertFrozenEnvironment(process.env);
const role = process.env.RUNTIME_ROLE ?? 'api';
if (role === 'producer') {
  const mode = process.env.NODE_MARKET_PRODUCER_MODE ?? 'DRY_RUN';
  if (mode === 'WRITE' || mode === 'NEW_LIVE_EPOCH') {
    assertProducerCutover();
    const approval = mode === 'NEW_LIVE_EPOCH' ? loadNewEpochApproval() : null;
    const pool = poolForRole('bybit_producer');
    let lease: ProducerLease | null = null;
    try {
      await verifyProducerDbPreflight(pool);
      lease = await ProducerLease.acquire(pool);
      const repository = new MarketRepository(pool, lease);
      const used = approval ? await repository.newEpochApprovalUsed(approval.approval_id) : false;
      const epochId = randomUUID();
      await lease.startEpoch(epochId, '0.1.0');
      const effectiveMode = approval ? approvedStartupMode(used) : 'WRITE';
      const market = new MarketRuntime(effectiveMode, repository,
        undefined, undefined, () => { assertProducerCutover(); if (approval) loadNewEpochApproval(); },
        approval && !used ? { expectedGapStart: Date.parse(approval.expected_gap_start),
          record: (gapStart, firstVerified, minuteStart) =>
            lease!.recordNewLiveBoundary(approval.approval_id, epochId, gapStart,
              firstVerified, minuteStart) } : undefined);
      await market.start();
      const shutdown = () => {
        market.stop();
        void lease!.release().then(() => pool.end()).catch(() => { process.exitCode = 1; });
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    } catch (error) {
      if (lease) await lease.release();
      await pool.end();
      throw error;
    }
  } else if (mode === 'DRY_RUN' || mode === 'READ_ONLY') {
    const market = new MarketRuntime(mode);
    await market.start();
    process.on('SIGTERM', () => {
      process.stdout.write(`${JSON.stringify({ dryRunFinalStatus: market.status(), canonicalWrites: 0 })}\n`);
      market.stop();
    });
  } else {
    throw new Error('Unknown Node market producer mode');
  }
} else if (role === 'shadow') {
  await launchRestoredShadow();
} else if (role === 'api_shadow_readonly') {
  if (userInfo().username !== 'bybit_shadow') throw new Error('bybit_shadow OS user required');
  const activationId = process.env.SHADOW_ACTIVATION_ID;
  if (!activationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activationId)) {
    throw new Error('Existing Shadow activation UUID required');
  }
  const pool = poolForRole('bybit_shadow');
  try {
    await verifyPeerRole(pool, 'bybit_shadow');
    const view = shadowDbView(new MarketReadRepository(pool), new ShadowStateStore(pool), activationId);
    const app = makeApp(view);
    process.on('SIGTERM', () => { void app.close().finally(() => pool.end()); });
    await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
  } catch (error) { await pool.end(); throw error; }
} else if (role === 'api' || role === 'api_probe') {
  // API probe is public-market DRY_RUN only; it neither opens a DB writer nor starts inference/Shadow.
  const market = role === 'api_probe' ? new MarketRuntime('DRY_RUN') : null;
  if (market) await market.start();
  const marketStatus = () => market?.status() ??
    ({ connected: false, sourceFresh: false, status: 'NOT_DEPLOYED' });
  const view: RuntimeView = {
    health: () => {
      const status = marketStatus();
      return { status: 'not_ready', components: {
        process: 'up', database: 'not_verified', bybitWs: status.connected ? 'connected' : 'not_verified',
        sourceFresh: status.sourceFresh, inference: 'not_verified', shadowEngine: 'not_started',
        hourlyReport: 'not_started',
      } };
    },
    market: marketStatus,
    shadow: () => ({ forwardShadowStarted: false, equity: 100, trades: 0,
      winRate: null, profitFactor: null, mdd: 0, openPosition: null, sourceFresh: false }),
    metrics: () => ({ status: 'NOT_STARTED', totalTrades: 0 }),
    trades: () => [],
  };
  const app = makeApp(view);
  if (market) process.on('SIGTERM', () => market.stop());
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
} else throw new Error('Unknown runtime role');
