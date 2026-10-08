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

assertFrozenEnvironment(process.env);
const role = process.env.RUNTIME_ROLE ?? 'api';
if (role === 'producer') {
  const mode = process.env.NODE_MARKET_PRODUCER_MODE ?? 'DRY_RUN';
  if (mode !== 'DRY_RUN' && mode !== 'READ_ONLY') {
    throw new Error('Node canonical WRITE requires separate human-approved cutover and restart validation');
  }
  const market = new MarketRuntime(mode);
  await market.start();
  process.on('SIGTERM', () => market.stop());
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
