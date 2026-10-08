# Public BTCUSD inverse market DRY_RUN

Observed at 2026-10-08T03:55:14Z. `MarketRuntime('DRY_RUN')` connected to the Bybit public inverse WebSocket, performed public recent REST overlap at startup, and ran for roughly two minutes. Final status:

| Metric | Value |
| --- | ---: |
| WS connected | true |
| Finalized canonical 1m candles | 2 |
| Source fresh | true |
| Duplicate trades | 0 |
| Ordering violations | 0 |
| Late trades | 0 |
| Reconnect count | 0 |
| Integrity fault | false |
| Last error | none |
| Historical source gap | OPEN |

The finalized candles passed the runtime's official public kline OHLCV comparison; no candle is finalized on mismatch. This first observation is short and is not a 60-minute soak or a process-restart test. `DRY_RUN` performs no PostgreSQL writes, feature computation, model inference, Shadow simulation, private API calls, or orders. Source and Shadow readiness remain closed.

## Forced disconnect probe

At 2026-10-08T03:57:33Z a second `DRY_RUN` deliberately terminated its own public WebSocket after startup, without touching the Python producer. The client reconnected once, found three exact post-anchor REST/WS overlap trades, then finalized one 1m candle. Final status: `connected=true`, `continuity=true`, `sourceFresh=true`, `reconnectCount=1`, `lastRestWsOverlap=3`, duplicate/order/late counts all zero, and no integrity fault. `recoveredTrades=0`: this probe proved reconnect overlap, **not** a positive missing-trade REST backfill. Persistent DB restart, an outage requiring actual trade recovery, and production-role cutover remain unverified.
