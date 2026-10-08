# Node current-live epoch V3 — administrator handoff

**Preparation only. Do not run an operating Producer, Shadow, migration or canonical write from this document now.** The pending [V3 template](runtime/node_new_live_epoch_approval_v3.pending.json) is intentionally invalid for runtime. Approval ID `0f9b2760-fa13-47a0-bf7d-3a8c67902bf7` is distinct from V2 `b6514764-b05a-4c9d-a845-9bc458aa9f96`. The operator-reported DB anchor is trade `8fb3b0a4-71c2-50f5-8c27-fabc499b9b2f` at `2026-10-08T08:32:59.332Z`, last candle end `2026-10-08T08:33:00Z`. The two existing historical gaps remain OPEN. V2 approval, V2 epoch and all canonical rows must remain unchanged; no WS witnesses are backfilled for V2.

## A. Read-only preflight; stop on any mismatch

Run as administrator on the operating host. `psql` runs as the dedicated Unix peer and explicitly starts a read-only transaction. The two old gaps must remain OPEN. An unused V3 ID must return `f`.

```sh
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
git status --short
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT current_user; SELECT trade_id,exchange_timestamp,raw_sequence,price,size,side FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; SELECT timestamp FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1; SELECT EXISTS(SELECT 1 FROM bybit_live.node_live_epoch_boundaries WHERE approval_id='0f9b2760-fa13-47a0-bf7d-3a8c67902bf7'::uuid) AS v3_id_used; SELECT approval_id,epoch_id,historical_source_gap,gap_start,gap_end FROM bybit_live.node_live_epoch_boundaries ORDER BY recorded_at DESC LIMIT 3; COMMIT;"
```

Require both services inactive/disabled, no orphan process, exact trade ID **and** timestamp and candle end, unused V3 ID, and both existing gaps OPEN. A timestamp match without the trade-ID match is insufficient. A mismatched tail voids this template; do not edit the old artifact or guess a new value. PostgreSQL timestamp ties have no implied UUID/lexical order.

## B. Migration 005 and permissions — inspect, do not reapply

The operator reports migration 005 already applied, its two witness tables empty, immutable triggers enabled, Producer SELECT/INSERT and Shadow SELECT. Independently check before a later launch:

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT to_regclass('bybit_live.node_ws_messages') AS ws_messages,to_regclass('bybit_live.node_ws_trade_witnesses') AS trade_witnesses; SELECT tgrelid::regclass,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('bybit_live.node_ws_messages'::regclass,'bybit_live.node_ws_trade_witnesses'::regclass) ORDER BY 1,2; SELECT has_table_privilege('bybit_producer','bybit_live.node_ws_messages','SELECT') AS producer_message_select,has_table_privilege('bybit_producer','bybit_live.node_ws_messages','INSERT') AS producer_message_insert,has_table_privilege('bybit_producer','bybit_live.node_ws_trade_witnesses','SELECT') AS producer_witness_select,has_table_privilege('bybit_producer','bybit_live.node_ws_trade_witnesses','INSERT') AS producer_witness_insert,has_table_privilege('bybit_shadow','bybit_live.node_ws_messages','SELECT') AS shadow_message_select,has_table_privilege('bybit_shadow','bybit_live.node_ws_trade_witnesses','SELECT') AS shadow_witness_select,has_table_privilege('bybit_shadow','bybit_live.node_ws_trade_witnesses','INSERT') AS shadow_witness_insert,has_table_privilege('bybit_producer','bybit_live.node_ws_messages','UPDATE') AS producer_message_update,has_table_privilege('bybit_producer','bybit_live.node_ws_trade_witnesses','DELETE') AS producer_witness_delete; SELECT (SELECT count(*) FROM bybit_live.node_ws_messages) AS messages,(SELECT count(*) FROM bybit_live.node_ws_trade_witnesses) AS witnesses; COMMIT;"
```

Require both tables, both reject-mutation triggers enabled (`O`), the six SELECT/INSERT checks true, the three forbidden checks false, and pre-V3 counts zero. The migration's trade-witness primary key and frame foreign key are indexed; the `(exchange_timestamp,exchange_sequence)` forensic lookup has an index. No migration is executed in this task.

## C. Review-only binary and canary configuration

The source unit has `Restart=on-failure`. The first supervised V3 start **must** use the versioned [canary drop-in](../deploy/bybit-node-producer-v3-canary.conf) and `systemctl show ... -p Restart` must return `Restart=no`. Do not enable automatic restart before a successful, independently observed controlled restart. Preserve old approved artifacts and failed epoch rows. Do not install the pending template: its two authorization fields are false.

Only after a separate human decision, create a **new approved V3 artifact** referencing the pending template, with `approved_by_human=true`, a genuine `approved_at`, and `new_live_epoch_authorized=true`; keep `forward_shadow_may_start_after_new_epoch_health_pass=false`, `actual_orders_allowed=false`, and `private_api_allowed=false`. Review that its expected trade ID/timestamp still matches the DB and that the ID remains unused. Do not recycle the V2 approval. The Producer loader requires a root-owned file with no group/world write permission at `/etc/cryptoTrade/node_new_live_epoch_approval.json`. This approval does **not** authorize Shadow.

For a **later, separately approved** deployment, the administrator may stage and compare every compiled file, not only `main.js`:

```sh
sudo rsync -a --delete /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo diff -qr /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo install -d -o root -g root -m 0755 /etc/systemd/system/bybit-node-producer.service.d
sudo install -o root -g root -m 0644 /home/minhyeok/app/cryptoTrade/deploy/bybit-node-producer-v3-canary.conf /etc/systemd/system/bybit-node-producer.service.d/v3-canary.conf
sudo systemctl daemon-reload
systemctl show bybit-node-producer.service -p User -p Restart -p FragmentPath -p DropInPaths
```

Require an empty `diff` result, `User=bybit_producer`, `Restart=no`, no Python writer and one Node advisory-lock owner only. `rsync --delete` is **only** for the dedicated compiled `dist/` directory after admin approval; never target canonical DB, approval files or research artifacts. The exact approved-file install and service start are intentionally omitted until the human artifact and fresh preflight exist. No command above is executed by Codex.

## D. Supervised V3 start and three-candle gate (future only)

After approval and all A–C gates, the administrator may install the reviewed root-owned V3 artifact and start **only** the Node Producer once. Verify a new append-only `node_live_epoch_boundaries` row for the V3 approval; `gap_start` must equal `2026-10-08T08:32:59.332Z`, `gap_end` must be the first currently REST/WS-verified trade, and `historical_source_gap` must remain `OPEN`. The first partial minute is discarded; only complete future minutes may persist. The runtime validates exact official public inverse BTCUSD 1m OHLCV before every candle commit. Independently compare the first three complete V3 candles with official public kline using candle **end** in DB versus kline **start** in Bybit; require 3/3 exact OHLCV and consecutive minute ends. Do not infer raw-trade completeness from kline parity alone.

Read-only DB checks after those candles:

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,first_complete_minute_start,historical_source_gap FROM bybit_live.node_live_epoch_boundaries WHERE approval_id='0f9b2760-fa13-47a0-bf7d-3a8c67902bf7'::uuid; SELECT t.trade_id,t.exchange_timestamp,t.raw_sequence,t.price,t.size,t.side,w.connection_id,w.message_ordinal,w.message_index,w.receive_order,m.message_sha256 FROM bybit_live.node_ws_trade_witnesses w JOIN bybit_live.bybit_live_trades t USING(trade_id) JOIN bybit_live.node_ws_messages m ON m.connection_id=w.connection_id AND m.message_ordinal=w.message_ordinal ORDER BY t.exchange_timestamp DESC LIMIT 20; SELECT timestamp,open,high,low,close,volume,trade_count FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 3; COMMIT;"
```

Require each V3 WS-origin canonical trade to have exactly one frame and witness, matching ID/timestamp/sequence/price/size/side, and a valid raw frame SHA-256. Check duplicate trade IDs and candle timestamps are zero; audit no UPDATE/DELETE and zero Shadow rows. The Node repository commits trade, raw frame, witness, candle and health together. A missing/contradictory witness is not HEALTHY; it is an immediate fail-closed stop.

## E. Controlled restart — currently **not safe**

Only after the initial V3 checks pass should the administrator conduct a supervised restart with `Restart=no`. Before restart, capture the current tail, final three candles and latest complete WS witness groups. After restart, require exact persisted-anchor identity and raw-frame witness, current official REST/WS overlap, full ID/payload coverage of all recovered trades and provable ordering for each tied `(timestamp,seq)` group. Compare canonical counts, distinct IDs and timestamps, final three official klines, and no existing-row mutation before/after. A REST-only single-trade group may be recovered only when the reconciliation rules prove it; a REST-only member of a multi-trade tied group **fails closed**. If the anchor leaves REST's window, use an independently validated official raw archive or request another human-approved new epoch; never automatically create one, close either old gap, or infer order from REST array/UUIDs.

`RESTART_SAFETY=FAIL` remains the operating status until an actual controlled V3 restart satisfies all gates. Producer and Shadow remain stopped during this preparation task; there are no orders, private API calls or API keys.
