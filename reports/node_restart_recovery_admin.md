# Node restart reconciliation: read-only forensic handoff

Current operating gate: both Python and Node producers must remain **stopped**; Shadow must remain stopped. Do not install this code into the active service path or start a canonical writer during this forensic phase. Existing failed `node_producer_epochs` rows are append-only evidence and must not be deleted. No approval artifact is edited by this change.

## Evidence and meaning of `seq`

The operator's read-only canonical tail output shows many distinct IDs at `2026-10-08 07:02:48.786+00` with identical `raw_sequence=118887015567`, differing prices and sizes. The Node guard previously treated `(millisecond,seq)` as unique and threw `Ambiguous post-anchor exchange sequence` when a second ID shared that key. [Bybit's public trade documentation](https://bybit-exchange.github.io/docs/v5/websocket/public/trade) says a message has up to 1024 trades, multiple messages can share a `seq`, and a message's trade array is ordered by match time. Thus `seq` is a cross-sequence/batch witness, not an individual fill ordinal; UUID lexical order is not valid.

The revised algorithm verifies each ID and payload against REST/WS, verifies the entire persisted anchor millisecond group, and retains WS source order for a fully observed tied `(millisecond,seq)` group. REST array order does not break ties. If any member of such a group is REST-only, the execution order cannot be proven and the restart **still fails closed**. This is intentional, even when all prices in a group happen to match. It does not silently drop or reorder trades, change timestamp precision, or update/delete historical rows. A tied batch crossing the persisted anchor without a complete ordering witness also fails closed. Official 1m kline parity remains an independent downstream guard.

## A. Inspect service state and build the forensic binary

Read-only local checks:

```sh
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
git status --short
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
```

Require both services inactive, no writer process, all checks PASS. An enabled service can auto-start at boot; keep both disabled during forensics. Do not modify the existing `/opt/cryptoTrade-runtime` deployment yet.

## B. Independent forensic install; no service unit

Administrator-only installation into a *separate* read-only path. No model, research data, secrets or Shadow code are needed to execute the diagnostic entrypoint; `dist/` contains application modules but this command imports only public market and read-only DB components.

```sh
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-forensic /opt/cryptoTrade-forensic/dist
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-forensic/dist/
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/package.json /home/minhyeok/app/cryptoTrade/package-lock.json /opt/cryptoTrade-forensic/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-forensic ci --omit=dev --ignore-scripts
sudo chown -R root:bybit_producer /opt/cryptoTrade-forensic
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-forensic
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-forensic/dist/producer-restart-forensics.js
```

The last program requires `bybit_producer` Unix peer auth, sets PostgreSQL `default_transaction_read_only=on`, reads the real persisted tail, buffers current **public** WS trades, queries official **public** recent trades, and applies the fixed reconciliation in memory. It prints `anchorTrade`, full persisted anchor group, same-sequence groups with REST and WS ordered ID arrays, overlap, recovered/missing IDs, duplicate count, ordering violations and the exact failure reason. `canonicalWrites=0` is enforced by the connection configuration. It does not request a writer lease, install a systemd unit, or create an epoch.

Interpretation:

- `reconciliationResult=PASS`, nonzero `restWsOverlap`, zero duplicate/ordering violations, and a full persisted anchor group are required to consider a later production retry. Review each recovered group: a tied batch must be fully WS-witnessed; no REST-only member may be silently ordered.
- `Pre-disconnect anchor absent`, `REST window does not cover full anchor millisecond group`, or an incomplete tied group means **FAIL**, not permission to skip the gap. If the REST 1,000-trade window has advanced beyond the anchor, obtain an official archive/other complete ordering witness or a separately approved new epoch. Do not use a kline as a substitute for raw-trade ordering.
- `RESTART_SAFETY` stays `NOT_VERIFIED` after this read-only test. A later controlled production restart is required to mark it PASS.

## C. Administrator-only later deployment — separate approval required

Do **not** run these steps during this forensic task. Once the read-only result, full trade/candle parity and a separate operator approval are reviewed, follow the existing [new-live-epoch cutover](node_new_live_epoch_cutover.md) with the corrected compiled `dist/`. Confirm Python remains stopped/disabled and no orphan process exists. A fresh Node restart must reconcile its persisted current-epoch tail, produce three new complete 1m candles with official kline parity `3/3`, show zero duplicate trade IDs/candle timestamps, zero ordering/late faults and no existing-row mutation. Only then set `RESTART_SAFETY=PASS`. Shadow activation remains a separate later gate.

Rollback on a failed later retry: stop the Node service; do not automatically start Python or remove failed epoch rows. No actual order or private API path is involved.
