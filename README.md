# cryptoTrade — Forward Shadow runtime

TypeScript/Node 22 prototype for Bybit BTCUSD inverse perpetual public-market observation and a frozen, simulated strategy. **No exchange order code, private API, or API key is present.** This branch is **not approved for production cutover or Shadow activation**.

The original research, model and canonical source remain in `btcMarketData`. This repository does not ship model artifacts, secrets or historical market data. A local Python worker loads the original frozen model for inference; it never trains. The frozen strategy uses a 5-minute decision, actionable confidence ≥0.55, one position, a direction-flip exit or 5-minute horizon, $100 initial equity, 20% equity isolated allocation, 1.8× exposure, 5.5 bp taker fee and 2 bp adverse slippage per leg.

## Current gate

The public WebSocket and REST-overlap reader, candle builder, inverse-PnL engine, Python inference adapter, API skeleton and tests are implemented. The Node writer remains forcibly disabled, the Shadow role refuses to start, and the API explicitly reports `NOT_DEPLOYED`. Persistent database state recovery, reconnect gap reconciliation, complete Python candle/feature parity, contract rounding/liquidation verification, and live restart tests remain required. Do not mistake a successful build for operational readiness.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Copy `.env.example` into an untracked local environment file only when needed. No database password or Bybit credential is required or supported. `npm run build` produces ESM under `dist/`. The default PM2 config runs only the loopback API; the separate producer config is dry-run and the Shadow config is fail-closed. See [operations](docs/operations.md) and [cutover](docs/python-to-node-cutover.md).

## API

`GET /health`, `/api/market/status`, `/api/shadow/status`, `/api/shadow/metrics`, and `/api/shadow/trades` return JSON. Until a supervised, verified runtime is attached, they report not deployed rather than fabricated live results.

Historical reference only: Development 221 trades, 59.28% win rate, PF 1.803; Validation 44 trades, 61.36% win rate, PF 2.679. These figures are not reproduced or optimized by this runtime.

See [architecture](docs/architecture.md), [strategy](docs/shadow-strategy.md), and [parity results](reports/node_shadow_parity.md).
