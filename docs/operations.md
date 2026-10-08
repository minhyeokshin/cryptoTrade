# Operations

Run verification using `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. `pm2 start ecosystem.config.cjs` launches only the loopback API, not a market writer or Shadow engine. `pm2 status`, `pm2 logs btc-shadow-node`, and `pm2 restart btc-shadow-node` operate on that API only. Producer and Shadow PM2 templates are not production activation commands.

Public feeds: `wss://stream.bybit.com/v5/public/inverse` with `publicTrade.BTCUSD`, `kline.1.BTCUSD`, `kline.5.BTCUSD`; heartbeat is 20 seconds. No API keys. Local Python inference requires the original research environment/model path and hash verification. SMTP credentials, if ever configured, belong only in untracked runtime environment; do not put them in logs or git.

Operational blockers: writer cutover, reconnect gap proof, source freshness soak, Python candle/feature parity, persistent Shadow journal/restart, verified inverse quantity/liquidation rules, hourly scheduler/mail idempotency, live API wiring. Until closed, `FORWARD_SHADOW_STARTED=FALSE`, actual orders and private API calls remain zero.
