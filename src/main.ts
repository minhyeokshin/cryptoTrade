import { assertFrozenEnvironment } from './config/frozen.js';
import { makeApp } from './app.js';
import { MarketRuntime } from './market/market-runtime.js';
import type { RuntimeView } from './api/routes/health.js';
import { launchRestoredShadow } from './shadow/launch.js';

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
