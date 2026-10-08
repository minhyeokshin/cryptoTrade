# Node Epoch V2 — administrator commands after separate approval

**Do not execute yet.** Gate: [approval precheck](node_epoch_v2_approval_precheck.md) must show exact `3/3` official OHLCV, raw aggregation and defensible close parity, correct DB tail/candle, prior OPEN boundary, unique samples, and a new human approval. `RESTART_SAFETY` is not yet verified. These commands do not close either historical gap or start Shadow.

## Read-only compiled audit first

After reviewing the source and `npm run build`, install into a **separate** forensic path, not the active producer path:

```sh
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-forensic /opt/cryptoTrade-forensic/dist /opt/cryptoTrade-forensic/reports /opt/cryptoTrade-forensic/reports/runtime
sudo rsync -a dist/ /opt/cryptoTrade-forensic/dist/
sudo install -o root -g bybit_producer -m 0640 package.json package-lock.json /opt/cryptoTrade-forensic/
sudo install -o root -g bybit_producer -m 0640 reports/runtime/node_new_live_epoch_approval_v1.json reports/runtime/node_new_live_epoch_approval_v2.pending.json /opt/cryptoTrade-forensic/reports/runtime/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-forensic ci --omit=dev --ignore-scripts
sudo chown -R root:bybit_producer /opt/cryptoTrade-forensic
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-forensic
sudo -u bybit_producer sh -c 'cd /opt/cryptoTrade-forensic && PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node dist/producer-old-epoch-integrity-audit.js'
```

The last command sets the working directory to `/opt/cryptoTrade-forensic` because the two reference JSON files are relative paths. The script uses a read-only PostgreSQL session and official public REST only. A nonzero exit or `oldEpochIntegrity=false` blocks approval.

## Later supervised v2 deployment (only after human approval)

The operator must create a **new**, reviewed approval file at `/var/tmp/node_new_live_epoch_approval_v2.approved.json` with the pending v2 ID, the independently verified `expected_gap_start`, `approved_by_human=true`, a real `approved_at`, `new_live_epoch_authorized=true`, and the two safety booleans false. Never edit the v1 approval file. Preserve the pending template as evidence. Do not copy it directly to `/etc`.

```sh
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -Atc "BEGIN READ ONLY; SELECT to_char(exchange_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; COMMIT;"
sudo install -o root -g bybit_producer -m 0640 /var/tmp/node_new_live_epoch_approval_v2.approved.json /etc/cryptoTrade/node_new_live_epoch_approval.json
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo chown -R root:bybit_producer /opt/cryptoTrade-runtime
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-runtime
sudo install -o root -g root -m 0644 /home/minhyeok/app/cryptoTrade/deploy/bybit-node-producer.service /etc/systemd/system/bybit-node-producer.service
sudo systemctl daemon-reload
```

Require both services `inactive/disabled`, no process, and the tail exactly equal to approved `expected_gap_start`. Review the approved JSON and permissions before the install. The active unit template currently has `Restart=on-failure`; for the **first supervised v2 start**, the administrator must replace that with a temporary `Restart=no` drop-in or equivalent approved canary unit so a failure does not create repeated failed epoch rows. The above install commands do **not** enable or start the service. Do not proceed if the canary restart policy is not reviewed.

Only after the independent approval, canary restart policy, REST/WS current overlap, DB peer-role preflight, and writer exclusivity pass may the administrator start the Node producer. Then verify the second append-only OPEN boundary, first complete future minute, three finalized candles with official OHLCV parity, duplicates/order faults 0, source freshness, and a controlled restart. If old-anchor restart fails because REST has advanced or WS intra-batch order cannot be proven, stop it; use official raw archive with full evidence or obtain a **third** human approval for another epoch. Never silently reuse v2 or start Python simultaneously. Do not start Shadow from this document.
