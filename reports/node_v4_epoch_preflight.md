# V4 pending current-live Epoch: approval and launch preflight

This is **preparation, not an approval or a start instruction**. The [V4 template](runtime/node_new_live_epoch_approval_v4.pending.json) has a new UUID and intentionally fails the runtime approval guard (`approved_by_human=false`, `new_live_epoch_authorized=false`). No service, DB row, migration, existing approval, or OPEN gap was changed by this preparation.

## Fixed evidence and independent gates

Operator-confirmed prior state: V3 approval `0f9b2760-fa13-47a0-bf7d-3a8c67902bf7`, epoch `b2f1a6f4-c109-4c58-98ce-69bed75346ab`, boundary created, but **zero** subsequent canonical trades/candles and **zero** WS frame/witness rows. Last canonical trade `8fb3b0a4-71c2-50f5-8c27-fabc499b9b2f` at `2026-10-08T08:32:59.332Z`; last candle end `2026-10-08T08:33:00Z`. Three historical gaps stay OPEN. Migration 005 is reported APPLIED. The operator reports `DIFF_EXIT_CODE=0` for the entire deployed `dist` against source commit `a5e0fdeed56ffa2ffbd4b9eeef9f4ec092ec7c1f`; this is **operator-verified historical evidence**, not a fresh pre-start check.

V4 template ID `5a3f2037-e6c5-451f-a34a-73051158aea5` differs from V3 and sets `previous_approval_id` to V3. The human must re-check that the V4 ID is unused, the exact trade **ID and timestamp** and candle still match, and the deployed `dist` still matches immediately before making a *separate* approved artifact. If any value changed, do not silently edit the pending template or use an old approval.

## Producer approval is not Shadow approval

`validateNewEpochApproval()` requires a human-approved producer artifact, explicit time, distinct predecessor/new IDs, exact DB tail checked at startup, an OPEN historical-gap policy and both order/private-API permissions false. `forward_shadow_may_start_after_new_epoch_health_pass=false` is allowed for the **Producer**; Shadow has a different launch/activation gate. A V4 Producer start must never start Shadow implicitly. The V3 approval is already present in `node_live_epoch_boundaries`; `approvedStartupMode(true)` routes to strict `WRITE`, not a second new epoch. V4 must be a new, unused ID; V2/V3 approvals and boundaries are immutable evidence.

## Administrator read-only pre-start checks

Do not run service start from this document. An administrator should run these immediately **before a later separately approved V4 start** and stop on any failure:

```sh
cd /home/minhyeok/app/cryptoTrade
git rev-parse HEAD
git status --short
npm run lint
npm run typecheck
npm test
npm run build
sudo diff -qr /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo sha256sum /opt/cryptoTrade-runtime/dist/main.js /opt/cryptoTrade-runtime/dist/market/bybit-ws.js /opt/cryptoTrade-runtime/dist/market/ws-ordering-witness.js /opt/cryptoTrade-runtime/dist/db/repositories/market.js
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
systemctl show bybit-node-producer.service -p Restart -p MainPID -p NRestarts -p User -p DropInPaths
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
```

Require `git rev-parse HEAD=a5e0fdeed56ffa2ffbd4b9eeef9f4ec092ec7c1f` **for this pinned runtime**, clean source tree other than reviewed pending/docs changes, all four checks PASS, `sudo diff -qr` exit code **0** with no output (the four hashes are supporting evidence, not a replacement for whole-`dist` comparison), both Producers inactive/disabled and no orphan process, `Restart=no`, `MainPID=0`, `User=bybit_producer`. If a later approved runtime code commit supersedes the pin, review and re-pin the approval instead of ignoring a mismatch. Do not auto-enable restart after first health check.

Dedicated peer-auth DB preflight; transaction is read-only and tail/approval lookups use existing timestamp/key indexes:

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT current_user; SELECT trade_id,exchange_timestamp FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; SELECT timestamp FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1; SELECT approval_id,epoch_id,historical_source_gap FROM bybit_live.node_live_epoch_boundaries ORDER BY recorded_at DESC LIMIT 4; SELECT EXISTS(SELECT 1 FROM bybit_live.node_live_epoch_boundaries WHERE approval_id='5a3f2037-e6c5-451f-a34a-73051158aea5'::uuid) AS v4_id_used; SELECT to_regclass('bybit_live.node_ws_messages') AS ws_messages,to_regclass('bybit_live.node_ws_trade_witnesses') AS ws_trade_witnesses; SELECT tgrelid::regclass,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('bybit_live.node_ws_messages'::regclass,'bybit_live.node_ws_trade_witnesses'::regclass) ORDER BY 1,2; SELECT EXISTS(SELECT 1 FROM bybit_live.node_ws_messages) AS any_ws_message,EXISTS(SELECT 1 FROM bybit_live.node_ws_trade_witnesses) AS any_ws_witness; COMMIT;"
```

Require `current_user=bybit_producer`, exact old trade ID/time and candle, V3 boundary preserved, all three existing historical gaps OPEN, V4 ID unused (`f`), both witness tables present, reject-mutation triggers enabled and no V2/V3 witness backfill. Recheck producer SELECT/INSERT and Shadow SELECT-only grants as documented in [V3 admin handoff](node_v3_epoch_admin_handoff.md). The template itself is not installable; a human must separately create and review a root-owned approved artifact with a genuine approval time. `actual_orders_allowed=false`, `private_api_allowed=false` and Shadow authorization false stay fixed. No Python/Node concurrent writer.

## WS frame/witness transaction and restart boundary

The latest source attaches the raw `publicTrade.BTCUSD` frame, SHA-256, connection UUID, message ordinal, array index and receive order to each WS trade. `MarketRepository.persist()` validates the frame/payload and inserts a **new** canonical WS trade, frame, per-trade witness, candle and health state in one transaction; a missing/conflicting witness rolls back rather than marking HEALTHY. It does not modify existing canonical rows. Only **new V4** WS-origin trades gain witnesses; no V2/V3 witness is fabricated. A newly approved V4 starts at the first complete future minute after current public REST/WS exact overlap and records a separate OPEN boundary; the three old gaps remain OPEN.

After any separately approved V4 start, independently check frame-to-witness-to-canonical ID/timestamp/sequence/price/size/side parity, unique IDs, three consecutive finalized candles and official Bybit inverse 1m OHLCV 3/3. A supervised restart with `Restart=no` must then recover from the persisted V4 anchor without duplicate trade/candle rows or mutation. Replayed already-persisted trades require exact payload and stored witness; never sort tied groups by UUID or REST array order. A REST-only **single** post-anchor `(timestamp,seq)` group may be recovered only when the existing algorithm proves overlap/order. A REST-only member of a **multi-trade** tied group has no complete WS ordering witness and fails closed. If the old anchor is outside REST's window, an independently verified official raw archive or another separately approved epoch is required. No approval ID is reused and no new Epoch is automatic. `RESTART_SAFETY=FAIL` until a real supervised restart passes.

`V4_APPROVAL_READY` here means only that the **pending template and handoff** are ready for human review; it does **not** mean approved, deployed or safe to start. `FORWARD_SHADOW_STARTED=FALSE`, `ACTUAL_ORDERS=0`, `PRIVATE_API_CALLS=0` remain fixed.
