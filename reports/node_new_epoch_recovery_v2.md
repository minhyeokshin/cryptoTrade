# Node current-live epoch recovery v2 — preparation only

Status: **BLOCKED pending read-only DB evidence and a separate human approval.** No service was started and no canonical row was written, updated, or deleted by this work. The old `2026-10-08T07:02:54.737Z` anchor is outside the reported 1,000-row recent REST window; strict `WRITE` reconciliation correctly fails closed. Do not treat this as continuity across the gap.

## Observed facts and unresolved evidence

- Operator forensic result: 98/98 tests, REST 1,000 rows, WS 26 rows, REST/WS exact overlap 26, ordering violations 0. `reconcileRecent` failed with `Pre-disconnect anchor absent or mismatched`.
- Operator-reported last persisted trade: `2026-10-08T07:02:54.737Z`, ID `944d1e11-80f8-5560-a97b-d14d93a252d0`, raw sequence `118887018575`. Last persisted candle and complete old-epoch integrity are **NOT_VERIFIED** from this account; run the read-only peer command below before approval.
- At this review, `bybit-producer.service` and `bybit-node-producer.service` were both inactive and disabled; no corresponding producer process was observed. Recheck immediately before any approved start.
- Existing first OPEN gap: from the former tail `2026-10-08T05:55:50.099Z` to the first verified trade recorded under approval `90c276e6-f9d6-457b-a659-d8e3d254116a`; query the append-only boundary row for its exact end. Do not close it.
- Proposed second OPEN gap: from the **DB-verified** old Node tail (expected `2026-10-08T07:02:54.737Z`) to the first REST/WS-verified trade of a future separately approved epoch. End is unknown until startup; it must become a second row of `bybit_live.node_live_epoch_boundaries` under a new approval ID. Failed `node_producer_epochs` rows remain untouched.

The pending template is [`node_new_live_epoch_approval_v2.pending.json`](runtime/node_new_live_epoch_approval_v2.pending.json), with a distinct ID. It is deliberately **invalid for runtime** (`approved_by_human=false`, `new_live_epoch_authorized=false`). Only a human operator may inspect the evidence, set a real approval time and the true DB tail, and install an approved root-owned artifact. The previous v1 artifact must remain unchanged. Updated startup validation rejects missing human approval, missing predecessor ID, or reuse of the predecessor ID. An already-used v2 approval still routes to strict persisted-anchor recovery; if that cannot be proven, a **new** approval is required, not silent new-epoch fallback.

## Read-only DB audit (operator, no password)

Run exactly as the dedicated OS role. Each invocation is read-only; do not run as `btcuser` or mutate canonical rows.

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT current_user; SELECT trade_id,exchange_timestamp,raw_sequence,price,size,side FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 20; SELECT timestamp,open,high,low,close,volume,trade_count,source_status FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 10; COMMIT;"
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,first_complete_minute_start,historical_source_gap FROM bybit_live.node_live_epoch_boundaries ORDER BY recorded_at; SELECT epoch_id,epoch_start,runtime_version,historical_source_gap FROM bybit_live.node_producer_epochs ORDER BY epoch_start DESC LIMIT 20; COMMIT;"
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; WITH t AS (SELECT trade_id,exchange_timestamp,raw_sequence,price,size,side FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1000), c AS (SELECT timestamp,open,high,low,close,volume,trade_count FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 20) SELECT 'trade_ids' AS check_name,count(*)::text AS rows,count(DISTINCT trade_id)::text AS unique_rows FROM t UNION ALL SELECT 'candle_timestamps',count(*)::text,count(DISTINCT timestamp)::text FROM c; COMMIT;"
```

Review the last three fully finalized candles against official Bybit public 1m kline by exact OHLCV, verify no timestamp regression in an ordered raw source, and compare the reported old tail to the DB result. A SQL sort of tied millisecond/sequence trades cannot prove their exchange order; do not claim that it does. Check append-only triggers and any late-trade/health errors separately. If DB tail differs, revise the pending template and stop. No `UPDATE`, `DELETE`, or repair follows from this audit.

## Recovery design decision

| Route | Evidence requirement | Decision |
| --- | --- | --- |
| A. Durable append-only WS raw batches | Preserve original message/batch identity, array index, raw ID, sequence and receive time before canonical finalization. Replay must prove complete coverage and exact REST payload parity; DB timestamps/UUID lexical order alone are insufficient. | Future improvement; **not present for the missed interval**, so not proof for this restart. |
| B. Official raw archive | Official archive must cover the whole missing interval, with exact lower/upper identity overlap, row/schema/order validation and canonical millisecond parity. | Valid supervised recovery route when available; do not use recent REST alone for a long gap. No archive write in this task. |
| C. New current-live epoch | Distinct human-approved ID; old tail frozen, both OPEN gaps recorded independently; current WS-first buffer and REST exact overlap; discard partial minute. | Chosen **preparation** path, not activated. Old gap stays OPEN. |
| D. REST/WS and kline parity | Exact ID/timestamp/price/size/side/sequence overlap, zero ordering faults, three consecutive future finalized 1m candles with exact official OHLCV. | Mandatory after an approved start; current 26/26 overlap does not establish future candle or restart safety. |

## Safe supervised execution gate (not authorized by this document)

1. Obtain the DB audit above. Confirm both producers stopped/disabled and no orphan process, correct peer role, writer lock availability, unchanged canonical rows, and old boundary/failed epochs retained. The v2 template must be signed by a human into a *separate* root-owned runtime approval; never copy the pending template directly to `/etc/cryptoTrade/node_new_live_epoch_approval.json`.
2. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Inspect `src/market/reconcile.ts` fail-closed tied-group tests and v2 approval tests. Deploy only after review, never start automatically from this report.
3. On approved future startup, WS open/subscription/trade occurs before current REST. Require exact REST/WS IDs and payload/sequence overlap, no ordering faults, and `historicalGapStart()` exactly matching the approval's `expected_gap_start`. `recordNewLiveBoundary` appends a new row with the distinct approval ID, gap end as first verified trade, `historical_source_gap='OPEN'`. It does not update the old row. The first partial minute is discarded; only the next complete future minute may persist.
4. Verify at least three consecutive finalized candles, exact official public 1m OHLCV parity, duplicate trade IDs/candle timestamps 0, late/order faults 0, and source freshness. No feature/inference/Shadow starts from this report.
5. Perform one controlled restart while supervised. If the persisted anchor and tied-group order are fully witnessed by REST/WS, resume strictly. If not, stop; use route B (official archive) or obtain a **third** approval for route C. Never automatically turn a failed strict restart into a fresh epoch, never erase failed epoch rows, never infer an intra-batch order from UUIDs, and never enable auto-restart loops until this passes.

## Current gate

`NEW_EPOCH_APPROVAL_REQUIRED=TRUE` · `OLD_EPOCH_DB_INTEGRITY=NOT_VERIFIED` · `CURRENT_REST_WS_OVERLAP=26/26 (operator forensic snapshot)` · `NEW_EPOCH_STARTED=FALSE` · `SOURCE_FRESHNESS=NOT_VERIFIED` · `RESTART_SAFETY=NOT_VERIFIED` · `FORWARD_SHADOW_STARTED=FALSE` · `ACTUAL_ORDERS=0` · `PRIVATE_API_CALLS=0`.
