# Node Epoch V2 approval precheck — read-only, pending DB comparison

Update: the operator later supplied a 3/3 exact OHLCV and `rawAggregation=true` audit. See [the candle audit review](node_epoch_v2_candle_audit_review.md) for the remaining `openChain=false` investigation and revised forensic-only rerun. The historical snapshot below is retained for provenance.

As of this audit, both producer services were `inactive` and `disabled`. No service start or canonical mutation was performed. The operator supplied the old Node tail (`944d1e11-80f8-5560-a97b-d14d93a252d0`, `2026-10-08T07:02:54.737Z`, sequence `118887018575`), last candle `2026-10-08T07:03:00Z`, 1,000/1,000 unique sampled trades, 20/20 unique sampled candle timestamps, and an OPEN prior gap. These are operator-confirmed, but their full query output was not available in this session.

## Official Bybit 1m kline evidence

Read from the [official public kline endpoint](https://bybit-exchange.github.io/docs/v5/market/kline) using `category=inverse`, `symbol=BTCUSD`, `interval=1`, `start=1791442800000`, `end=1791442979999`, `limit=3`. Bybit labels rows by **start**; canonical DB labels candles by **end**. Inverse volume is USD contract volume, matching the existing canonical `sum(size)` contract.

| Canonical end UTC | Official start UTC | Open | High | Low | Close | Volume |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 07:01 | 07:00 | 82786 | 82786 | 82725.1 | 82736.8 | 897845 |
| 07:02 | 07:01 | 82736.8 | 82736.8 | 82706.9 | 82706.9 | 39834 |
| 07:03 | 07:02 | 82706.9 | 82706.9 | 82668.2 | 82668.7 | 2281967 |

The public response returned `retCode=0`. **Exact DB parity remains NOT_VERIFIED** until the dedicated peer-role read-only output below is compared; official values alone are not a PASS.

## Operator read-only query

Run as `bybit_producer`. This does not ask for a DB password and does not write. Do not sort trades sharing the same timestamp/sequence by UUID or infer their original intra-batch order from this result.

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT current_user; SELECT trade_id,exchange_timestamp,raw_sequence,price,size,side FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; SELECT timestamp,open,high,low,close,volume,trade_count FROM bybit_live.bybit_live_candles_1m WHERE timestamp >= '2026-10-08 07:01:00+00' AND timestamp <= '2026-10-08 07:03:00+00' ORDER BY timestamp; SELECT date_trunc('minute',exchange_timestamp)+interval '1 minute' AS candle_end,count(*) AS trade_count,sum(size) AS raw_volume,min(price) AS raw_min_price,max(price) AS raw_max_price,max(exchange_timestamp) AS last_trade_timestamp FROM bybit_live.bybit_live_trades WHERE exchange_timestamp >= '2026-10-08 07:00:00+00' AND exchange_timestamp < '2026-10-08 07:03:00+00' GROUP BY 1 ORDER BY 1; SELECT trade_id,exchange_timestamp,raw_sequence,price,size,side FROM bybit_live.bybit_live_trades WHERE exchange_timestamp='2026-10-08 07:02:54.737+00'; COMMIT;"
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,historical_source_gap FROM bybit_live.node_live_epoch_boundaries ORDER BY recorded_at; SELECT epoch_id,epoch_start FROM bybit_live.node_producer_epochs ORDER BY epoch_start DESC LIMIT 20; COMMIT;"
```

Additional read-only compiled audit: `src/producer-old-epoch-integrity-audit.ts`. It uses `poolForReadOnlyRole('bybit_producer')`, checks all five OHLCV fields against the official endpoint, compares raw count/volume/high/low with the canonical builder contract, and only verifies raw close when the last timestamp group has a single distinct price. It outputs `oldEpochIntegrity` and `newEpochV2ApprovalReady`; it cannot prove unseen intra-group WS order. This script is **not run here** because the current OS user cannot access the peer-role DB or `/opt/cryptoTrade-runtime`. Do not install the pending approval as a runtime marker.

## Approval checks and current verdict

- Pending v2 ID `b6514764-b05a-4c9d-a845-9bc458aa9f96` differs from prior v1 ID `90c276e6-f9d6-457b-a659-d8e3d254116a`: **TRUE**.
- Pending v2 `expected_gap_start=2026-10-08T07:02:54.737Z` matches the operator-confirmed tail timestamp: **TRUE (operator evidence)**; independent DB comparison by this process: **NOT_VERIFIED**.
- Existing v1 approval and failed epoch rows remain append-only; operator confirms prior gap OPEN. Second gap will only be appended under v2 approval after a separately approved startup.
- Last 3 exact DB/official kline parity: **NOT_VERIFIED**; raw aggregation: **NOT_VERIFIED**; therefore `OLD_EPOCH_INTEGRITY=NOT_VERIFIED` and `NEW_EPOCH_V2_APPROVAL_READY=FALSE`.

Approval readiness requires all three official/DB OHLCV exact matches, raw count/volume/high/low parity, defensible raw close for each minute, the exact last trade and candle, unique samples, preserved prior OPEN gap, and distinct v2 approval ID. The policy marker remains pending until a human explicitly approves it. Even then, restart safety is a separate operational gate and is **NOT_VERIFIED** here.
