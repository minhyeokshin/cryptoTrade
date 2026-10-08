# cryptoTrade — Forward Shadow runtime

TypeScript/Node 22 prototype for Bybit BTCUSD inverse perpetual public-market observation and a frozen, simulated strategy. **No exchange order code, private API, or API key is present.** This branch is **not approved for production cutover or Shadow activation**.

The original research, model and canonical source remain in `btcMarketData`. This repository does not ship model artifacts, secrets or historical market data. A local Python worker loads the original frozen model for inference; it never trains. The frozen strategy uses a 5-minute decision, actionable confidence ≥0.55, one position, a direction-flip exit or 5-minute horizon, $100 initial equity, 20% equity isolated allocation, 1.8× exposure, 5.5 bp taker fee and 2 bp adverse slippage per leg.

## Current gate

The public WebSocket and REST-overlap reader, candle builder, inverse-PnL engine, Python inference adapter, API skeleton and tests are implemented. The Node writer remains forcibly disabled, the Shadow role refuses to start, and the API explicitly reports `NOT_DEPLOYED`. Persistent database state recovery, reconnect gap reconciliation, complete Python candle/feature parity, contract rounding/liquidation verification, and live restart tests remain required. Do not mistake a successful build for operational readiness.

Append-only Shadow state-journal and hourly UTC scheduler code are prepared but neither database migration nor mail delivery has been activated. They must be reviewed and exercised under the dedicated peer-auth Shadow role before an operational readiness claim.

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
For a non-writing public-market API probe, set `RUNTIME_ROLE=api_probe` before running compiled `dist/main.js`; `/api/market/status` then reflects the in-memory DRY_RUN stream. It does not activate Shadow or canonical DB writes.
The optional `RUNTIME_ROLE=api_shadow_readonly` runs under the `bybit_shadow` OS/peer role with `PGUSER=bybit_shadow` and an existing `SHADOW_ACTIVATION_ID`. It SELECTs the canonical source and append-only Shadow journal for API responses, but never creates an activation or writes data. Its `runtimeVerified=false` and `forwardShadowStarted=false` fields are deliberate: a journal record is not proof that a supervised engine is alive. This mode is not enabled by the PM2 template.

Historical reference only: Development 221 trades, 59.28% win rate, PF 1.803; Validation 44 trades, 61.36% win rate, PF 2.679. These figures are not reproduced or optimized by this runtime.

See [architecture](docs/architecture.md), [strategy](docs/shadow-strategy.md), and [parity results](reports/node_shadow_parity.md).
