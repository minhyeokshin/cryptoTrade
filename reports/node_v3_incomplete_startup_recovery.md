# V3 incomplete startup: read-only recovery decision

Decision date: 2026-10-08 UTC. **No service start, migration, canonical write, witness backfill, approval edit, or Shadow start was performed.**

Current verdict: `V3_RECOVERY_POSSIBLE=NO` under the present runtime contract; `V3_APPROVAL_REUSE=FORBIDDEN` for another new epoch; `NEW_EPOCH_REQUIRED=TRUE` for the forward-only route; `LATEST_DIST_MATCH=NOT_VERIFIED` (deployment inaccessible to this user); `WS_WITNESS_RUNTIME_READY=NOT_VERIFIED`; `RESTART_SAFETY=FAIL`.

## Operator evidence and code path

The operator reports approval `0f9b2760-fa13-47a0-bf7d-3a8c67902bf7` already used by boundary/epoch `b2f1a6f4-c109-4c58-98ce-69bed75346ab`. The boundary is append-only evidence: `gap_start=2026-10-08T08:32:59.332Z`, `gap_end=2026-10-08T13:52:24.681Z`, `historical_source_gap=OPEN`. The operating binary at V3 startup was outdated. Since that start, the operator reports **zero new canonical trades, zero new canonical 1m candles, zero raw WS frames and zero trade witnesses**. Both Producers are stopped and disabled, `Restart=no`, Shadow not started. These counts and the deployed binary were not independently readable by this Unix user; administrator peer-auth verification is below.

`src/main.ts` asks `MarketRepository.newEpochApprovalUsed()` whether a boundary exists for the approval ID. `approvedStartupMode(true)` returns **`WRITE`**, never `NEW_LIVE_EPOCH`. A restart using the same approval therefore calls `recoveryTail()` and `verifyPersistedWsWitnesses()`, then requires exact persisted-anchor REST/WS reconciliation. The V3 boundary's `gap_end` and `first_verified_trade_id` are metadata; they are **not** canonical persisted trades and cannot substitute for the DB anchor. With no V3 canonical write, `recoveryTail()` still returns the old V2 trade `8fb3b0a4-71c2-50f5-8c27-fabc499b9b2f` at `2026-10-08T08:32:59.332Z` and old candle end `08:33:00Z`, assuming the operator's zero-write evidence remains true. Current recent REST cannot be presumed to reach this old anchor. The old V2 WS frames are absent from migration 005, so there is no legitimate witness to manufacture. Existing OPEN gaps and the V3 boundary must remain unchanged.

The code also appends a `node_producer_epochs` STARTING row **before** `MarketRuntime.start()` reconciles. A failed retry can thus add another failed epoch record even though canonical writes remain zero. With `Restart=no` this is bounded to a supervised attempt, but it is not permission to retry blindly.

## Decision

Under the **current code and the stated no-repair/no-boundary-mutation policy**, V3 cannot be safely resumed as a new live epoch. `V3_RECOVERY_POSSIBLE=NO` for operational restart. Reusing its approval ID to create a second new boundary is forbidden; it always selects strict `WRITE`. A complete, officially sourced raw-trade recovery plus a separately reviewed implementation could be evaluated in a different task, but no such coverage/order evidence is supplied here and it must not be inferred from a kline. The minimal forward-only route is a **distinct, explicit human-approved V4 current-live epoch**, with `previous_approval_id=0f9b2760-fa13-47a0-bf7d-3a8c67902bf7`, an unused new approval UUID and `expected_gap_start` re-read from the exact canonical DB trade tail. V3 remains an OPEN, incomplete boundary. This is not an automatic fallback.

## Witness code readiness and limits

Source `src/market/bybit-ws.ts` captures the exact public WS frame, local connection UUID, frame ordinal, array index, receive order/time, exchange message ID and SHA-256. `src/market/ws-ordering-witness.ts` checks hash/topic/index/ID/timestamp/sequence/price/size/side. `MarketRepository.persist()` commits a **new** canonical WS trade, raw frame, trade witness, candle and health in one transaction; missing/conflicting witness rolls back. `verifyPersistedWsWitnesses()` fails closed on missing or contradictory stored evidence. No old V2/V3 rows are retroactively populated. This provides code-level readiness, **not** a live operating proof: the deployment path `/opt/cryptoTrade-runtime/dist` is root/bybit_producer-only and could not be compared by this user, the two witness tables are reported empty, and no current Producer was started. `WS_WITNESS_RUNTIME_READY=NOT_VERIFIED` until full admin `dist` parity, schema/role preflight and a supervised new-epoch write/restart are observed.

## Administrator read-only checks before any V4 approval

Run only as the administrator; these commands do not write or start a service. Stop if any result differs. In particular, compare **all** built files, not just the approval loader or `main.js`:

```sh
cd /home/minhyeok/app/cryptoTrade
git status --short
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
sudo diff -qr /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
systemctl show bybit-node-producer.service -p Restart -p NRestarts -p MainPID
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT trade_id,exchange_timestamp FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; SELECT timestamp FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1; SELECT approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,first_complete_minute_start,historical_source_gap FROM bybit_live.node_live_epoch_boundaries WHERE approval_id='0f9b2760-fa13-47a0-bf7d-3a8c67902bf7'::uuid; SELECT count(*) AS raw_frames FROM bybit_live.node_ws_messages; SELECT count(*) AS trade_witnesses FROM bybit_live.node_ws_trade_witnesses; COMMIT;"
```

Require empty `diff`, inactive/disabled services, no processes, `Restart=no`, exact old tail/candle, one V3 boundary with OPEN gap and zero witness rows (unless another independently approved action changed state). Verify migration 005 tables, reject-mutation triggers and role grants via [V3 admin handoff](node_v3_epoch_admin_handoff.md). The app source being current does **not** establish deployed `dist` parity. If the tail has changed, stop; a prospective V4 template must use the newly verified exact tail and trade ID, not this report's old value.

## Minimal later V4 sequence — separate human approval required

1. Preserve V2/V3 artifacts, failed epoch rows and all OPEN gaps. No UPDATE/DELETE or backfill of missing WS witness. Produce a **pending** V4 artifact with a new unused ID, V3 as predecessor, exact peer-verified DB tail, Shadow authorization false and order/private-API permissions false. Human reviews the binary diff, evidence and open gaps, then explicitly approves a separate root-owned artifact. Do not alter V3 approval.
2. Keep both Producers stopped/disabled and no orphan process; use a canary `Restart=no`. Verify entire built `dist` matches the deployed `dist`, migration 005 exists with correct triggers/grants, and the approved V4 ID remains unused immediately before startup. No Python/Node dual writer.
3. Only on separately authorized startup, connect public WS first, establish current REST/WS exact ID/payload overlap, append a **new** V4 boundary leaving the V3 gap OPEN, discard the partial minute, then persist only complete future minutes. Require a WS frame and trade witness for every new WS-origin canonical trade in the same transaction.
4. Require three consecutive finalized 1m candles with official public Bybit kline exact OHLCV 3/3, zero duplicate/order/late anomalies, fresh trade/candle timestamps and unchanged old rows. Perform a supervised controlled restart; a REST-only member of a tied `(timestamp,seq)` group or old anchor outside REST with no official raw ordering evidence still fails closed. Never auto-create V5 or start Shadow on failure.

`RESTART_SAFETY=FAIL`, `FORWARD_SHADOW_STARTED=FALSE`, `ACTUAL_ORDERS=0`, `PRIVATE_API_CALLS=0` remain the operating status.
