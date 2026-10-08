# Node CURRENT_LIVE_EPOCH cutover — administrator handoff

This procedure preserves the old canonical tail→new source interval as `HISTORICAL_SOURCE_GAP=OPEN`. It does **not** repair that interval, modify old rows, imply full historical continuity, or authorize Shadow by itself. The immutable approval is `reports/runtime/node_new_live_epoch_approval_v1.json`; the older approval artifacts remain unchanged. The expected old tail is `2026-10-08T05:55:50.099Z`. If the actual tail differs, **stop** and obtain a new explicit approval artifact with the verified tail; do not edit this one. Codex did not run the commands below.

## A. Review and build, without touching the running Python producer

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
pgrep -af 'blind_capture_daemon[.]py' || true
```

The current source only needs *current* official REST/WS overlap. Do not run `producer-reconcile-forensics` as a start gate: that old-anchor forensic command deliberately tests the historical gap and may fail. The new runtime first waits for socket open, public subscription ACK and one WS trade; then it verifies exact current REST/WS trade ID, millisecond timestamp, price, size, side and available sequence. A missing overlap fails closed.

## B. DBA migration and peer-role preflight

Apply migration 004 **only if** `to_regclass` returns null. Have the DBA inspect trigger/grants first. No canonical row UPDATE/DELETE occurs.

```sh
sudo -u postgres psql -d btc_analysis -Atc "SELECT to_regclass('bybit_live.node_live_epoch_boundaries');"
sudo install -m 0644 /home/minhyeok/app/cryptoTrade/src/db/migrations/004_node_live_epoch_boundaries.sql /var/tmp/cryptoTrade-004.sql
sudo -u postgres psql -d btc_analysis -v ON_ERROR_STOP=1 -f /var/tmp/cryptoTrade-004.sql
sudo -u postgres psql -d btc_analysis -Atc "SELECT to_regclass('bybit_live.node_live_epoch_boundaries');"
```

The third command is conditional; **skip it if the table already exists**. Verify the dedicated `bybit_producer` role has SELECT/INSERT and no UPDATE/DELETE on the new append-only table.

## C. Install reviewed code without enabling a writer

```sh
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-runtime /opt/cryptoTrade-runtime/dist
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/package.json /home/minhyeok/app/cryptoTrade/package-lock.json /opt/cryptoTrade-runtime/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-runtime ci --omit=dev --ignore-scripts
sudo chown -R root:bybit_producer /opt/cryptoTrade-runtime
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-runtime
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-db-preflight.js
sudo -u bybit_producer env RUNTIME_ROLE=producer NODE_MARKET_PRODUCER_MODE=DRY_RUN /usr/bin/timeout 180 /usr/bin/node /opt/cryptoTrade-runtime/dist/main.js
```

Require DB preflight PASS and a healthy current public REST/WS overlap in the 180-second dry run; timeout exit 124 alone is not evidence. Dry run writes zero canonical rows. `bybit-node-producer.service` remains stopped and disabled.

## D. Exclusive-writer switch (administrator only)

Before stopping Python, read the actual last trade as a dedicated peer session and compare it exactly to the immutable approval timestamp. If it differs, stop this cutover. A Python service that is `active` but failing/restarting is **not** a healthy source; this handoff does not claim otherwise.

```sh
sudo -u bybit_producer psql -d btc_analysis -Atc "SELECT to_char(exchange_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1;"
sudo systemctl stop bybit-producer.service
sudo systemctl disable bybit-producer.service
systemctl is-active bybit-producer.service
systemctl is-enabled bybit-producer.service
systemctl show -p MainPID --value bybit-producer.service
pgrep -af 'blind_capture_daemon[.]py' || true
```

Require `inactive`, `disabled`, `0`, and no Python process. Re-read the DB tail; it must still equal the approval's `expected_gap_start`. The old writer approval and new live-epoch approval must both be root-owned and not group/world writable. The Node code checks Python shutdown at startup and before every write and retains the PostgreSQL advisory writer lock.

```sh
sudo install -d -o root -g bybit_producer -m 0750 /etc/cryptoTrade
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/deploy/node_writer_cutover_approval.json /etc/cryptoTrade/node_writer_cutover.json
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/reports/runtime/node_new_live_epoch_approval_v1.json /etc/cryptoTrade/node_new_live_epoch_approval.json
sudo install -o root -g root -m 0644 /home/minhyeok/app/cryptoTrade/deploy/bybit-node-producer.service /etc/systemd/system/bybit-node-producer.service
sudo systemctl daemon-reload
sudo systemctl enable --now bybit-node-producer.service
systemctl status bybit-node-producer.service --no-pager
journalctl -u bybit-node-producer.service -n 100 --no-pager
```

On first start, the Node runtime uses the approval ID once. It records an append-only gap boundary containing the old tail, first verified current REST/WS trade, and first *complete future* minute. The partial startup minute is discarded. No old-anchor REST bridge is attempted. The gap is always `OPEN` in this workflow. If startup fails after the approval ID is recorded but before a candle commits, **do not bypass the one-use rule**; investigate and obtain fresh human approval. On a normal restart using the same approval ID, Node must reconcile against its own persisted current-epoch tail. If that tail is no longer in recent REST, restart fails closed; a separate approved new epoch is required.

## E. Current-source and restart gates

```sh
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-source-audit.js
sudo -u bybit_producer psql -d btc_analysis -c "SELECT approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,first_complete_minute_start,historical_source_gap FROM bybit_live.node_live_epoch_boundaries ORDER BY recorded_at DESC LIMIT 3;"
sudo -u bybit_producer psql -d btc_analysis -c "SELECT timestamp,source_status,trade_count FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 5;"
```

Require current WS/REST overlap, three consecutive finalized post-boundary 1m candles, official kline parity `3/3`, fresh trade/candle/health timestamps under 3 minutes, zero duplicate/order/late faults and unchanged historical rows. Only then do the controlled restart:

```sh
sudo systemctl restart bybit-node-producer.service
systemctl status bybit-node-producer.service --no-pager
journalctl -u bybit-node-producer.service -n 100 --no-pager
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-source-audit.js
```

Require a strict persisted-current-anchor reconciliation, new fresh finalized candles, parity, zero duplicate IDs/candles, no ordering/late faults, and no old-row mutation. A failed restart leaves `RESTART_SAFETY=FAIL`; do not declare Forward Shadow ready.

## F. Shadow remains a later, separate gate

No Shadow service is installed or started by this handoff. The source gate does not override model parity, DB role, inference, idempotency, and per-activation human approval gates. `shadow-activate` now requires the entire frozen warmup window to be strictly after the new live-epoch first-complete-minute boundary. This can require substantially more than three candles. No pre-epoch data may enter feature computation or retroactive trades. The first Shadow decision must be a future fully finalized causal 5m point. `ACTUAL_ORDERS=0`, `PRIVATE_API_CALLS=0` and `LIVE_TRADING_GATE=CLOSED` remain invariant.

If Node fails, stop Node first. Do not automatically restart Python; that requires a separate approved rollback and must never create simultaneous writers.
