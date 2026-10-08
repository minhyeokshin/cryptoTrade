# Operations

Run verification using `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. `pm2 start ecosystem.config.cjs` launches only the loopback API, not a market writer or Shadow engine. `pm2 status`, `pm2 logs btc-shadow-node`, and `pm2 restart btc-shadow-node` operate on that API only. Producer and Shadow PM2 templates are not production activation commands.

Public feeds: `wss://stream.bybit.com/v5/public/inverse` with `publicTrade.BTCUSD`, `kline.1.BTCUSD`, `kline.5.BTCUSD`; heartbeat is 20 seconds. No API keys. Local Python inference requires the original research environment/model path and hash verification. SMTP credentials, if ever configured, belong only in untracked runtime environment; do not put them in logs or git.

Operational blockers: writer cutover, reconnect gap proof, source freshness soak, Python candle/feature parity, persistent Shadow journal/restart, verified inverse quantity/liquidation rules, hourly scheduler/mail idempotency, live API wiring. Until closed, `FORWARD_SHADOW_STARTED=FALSE`, actual orders and private API calls remain zero.

Reconnect recovery is deliberately narrow: public recent REST must still contain the exact trade immediately before disconnect and overlap the resumed public WS with matching IDs and canonical payloads. If not, the runtime stays blocked; an official historical archive or explicit new epoch procedure is required. Read-only unit tests do not count as a supervised disconnect/restart validation.
Three unsuccessful bounded reconciliation attempts cause a hard integrity fault; the process does not silently mark itself healthy. A manual restart is not itself proof that the gap was recovered—the same anchor and official-source checks still apply. Payload conflicts, late trades and official candle mismatches also require investigation before cutover.

The prepared hourly scheduler formats a zero-trade heartbeat and the database claim is at-most-once per UTC hour. It is not wired to a live snapshot provider. SMTP failure after claim cannot safely be retried without a reviewed delivery/outbox protocol; operators must inspect claimed-but-unsent hours. Do not mark hourly reporting operationally ready yet.
