import { assertFrozenEnvironment } from './config/frozen.js';
import { makeApp } from './app.js';
import { MarketRuntime } from './market/market-runtime.js';

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
  throw new Error('Shadow start blocked: Python model parity and persistent DB restart gate not verified');
} else if (role === 'api') {
  const view = {
    market: () => ({ connected: false, sourceFresh: false, status: 'NOT_DEPLOYED' }),
    shadow: () => ({ forwardShadowStarted: false, equity: 100, trades: 0,
      winRate: null, profitFactor: null, mdd: 0, openPosition: null, sourceFresh: false }),
    metrics: () => ({ status: 'NOT_STARTED', totalTrades: 0 }),
    trades: () => [],
  };
  const app = makeApp(view);
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
} else throw new Error('Unknown runtime role');
