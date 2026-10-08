# Node-only producer cutover: staged administrator handoff

Current read-only audit (2026-10-08): `bybit-producer.service` is **active and enabled**;
`ExecStart` is `/opt/btcMarketData-runtime/.venv/bin/python .../blind_capture_daemon.py --current-epoch`.
No service was stopped, disabled, installed, or started by Codex. Do not execute the stop/start phase until the
reviewer accepts the Node code, database migration, Python→Node parity, and rollback plan.

The producer uses systemd rather than PM2 because the database uses Unix-socket peer auth under the
`bybit_producer` OS account. The Node Shadow service is a separate later gate under `bybit_shadow`.

## A. Pre-cutover verification (safe with Python still running)

```sh
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
git status --short
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
systemctl cat bybit-producer.service
systemctl status bybit-producer.service --no-pager
pgrep -af 'blind_capture_daemon[.]py' || true
```

Pre-prospective parity checks only (no Final Test performance read):

```sh
cd /home/minhyeok/app/cryptoTrade
PYTHON_RESEARCH_ROOT=/home/minhyeok/app/btcMarketData PYTHON_BIN=/home/minhyeok/app/btcMarketData/.venv/bin/python node scripts/model-parity.mjs
PYTHON_RESEARCH_ROOT=/home/minhyeok/app/btcMarketData PYTHON_BIN=/home/minhyeok/app/btcMarketData/.venv/bin/python PRE_PROSPECTIVE_ARCHIVE=/home/minhyeok/app/btcMarketData/reports/bybit_live/quarantine/BTCUSD2026-09-30.csv.gz node scripts/candle-parity.mjs
```

Observed on 2026-10-08: 77/77 unit tests, lint/typecheck/build PASS; frozen model prediction
exact on one 2022 sample; Sep30 5,000 trades/388 candle aggregates exact. These are not live cutover evidence.

## B. DBA migration and role audit (administrator only)

First inspect whether each Node table exists. Apply an absent migration only once; the trigger DDL is not
idempotent. These commands must be run by the administrator, never by the application or Codex:

```sh
sudo -u postgres psql -d btc_analysis -Atc "SELECT to_regclass('shadow_trading_v1.node_hourly_reports'),to_regclass('shadow_trading_v1.node_shadow_journal'),to_regclass('bybit_live.node_producer_epochs');"
sudo install -m 0644 /home/minhyeok/app/cryptoTrade/src/db/migrations/001_shadow_hourly.sql /var/tmp/cryptoTrade-001.sql
sudo install -m 0644 /home/minhyeok/app/cryptoTrade/src/db/migrations/002_node_shadow_journal.sql /var/tmp/cryptoTrade-002.sql
sudo install -m 0644 /home/minhyeok/app/cryptoTrade/src/db/migrations/003_node_producer_epochs.sql /var/tmp/cryptoTrade-003.sql
```

For each table reported `NULL`, run only its corresponding command:

```sh
sudo -u postgres psql -d btc_analysis -v ON_ERROR_STOP=1 -f /var/tmp/cryptoTrade-001.sql
sudo -u postgres psql -d btc_analysis -v ON_ERROR_STOP=1 -f /var/tmp/cryptoTrade-002.sql
sudo -u postgres psql -d btc_analysis -v ON_ERROR_STOP=1 -f /var/tmp/cryptoTrade-003.sql
```

The migration only adds append-only live/Shadow tables; it does not change research/source data. A DBA must
review existing trigger names and grants first. Never run all three blindly if a table already exists.

## C. Deploy producer code to accessible path (administrator only)

`/home/minhyeok` is 0700. Do **not** relax it. Copy only compiled Node code and npm manifests; no model,
research dataset, Git metadata, `.env`, or secrets.

```sh
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-runtime
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-runtime/dist
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-runtime/dist/
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/package.json /home/minhyeok/app/cryptoTrade/package-lock.json /opt/cryptoTrade-runtime/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-runtime ci --omit=dev --ignore-scripts
sudo chown -R root:bybit_producer /opt/cryptoTrade-runtime
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-runtime
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-db-preflight.js
```

The last command must print `PRODUCER_DB_PREFLIGHT=PASS`. If it does not, stop here. Run a public-only Node
DRY_RUN probe and review output before stopping Python; it must not write canonical DB rows:

```sh
sudo -u bybit_producer env RUNTIME_ROLE=producer NODE_MARKET_PRODUCER_MODE=DRY_RUN /usr/bin/timeout 180 /usr/bin/node /opt/cryptoTrade-runtime/dist/main.js
```

Timeout exit 124 is expected after a healthy bounded probe. Investigate any earlier error. Do not install a
writer marker or start the Node writer while Python is running.

## D. Exclusive-writer transition (administrator only, approved maintenance window)

Only after A–C pass and the operator decides to cut over:

```sh
sudo systemctl stop bybit-producer.service
sudo systemctl disable bybit-producer.service
systemctl is-active bybit-producer.service
systemctl is-enabled bybit-producer.service
systemctl show -p MainPID --value bybit-producer.service
pgrep -af 'blind_capture_daemon[.]py' || true
```

Require `inactive`, `disabled`, `0`, and no matching Python process respectively. The Node `WRITE` startup
guard independently checks the same evidence before startup **and before each canonical commit**. A separate
session-scoped PostgreSQL advisory lock prevents two Node writers; the append-only epoch table records runtime
name/version/start/role. This cannot protect against a manually relaunched Python writer that ignores the lock,
so maintain the disabled legacy service and monitor for any orphan process.

After verifying Python is completely down:

```sh
sudo install -d -o root -g bybit_producer -m 0750 /etc/cryptoTrade
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/deploy/node_writer_cutover_approval.json /etc/cryptoTrade/node_writer_cutover.json
sudo install -o root -g root -m 0644 /home/minhyeok/app/cryptoTrade/deploy/bybit-node-producer.service /etc/systemd/system/bybit-node-producer.service
sudo systemctl daemon-reload
sudo systemctl enable --now bybit-node-producer.service
systemctl status bybit-node-producer.service --no-pager
journalctl -u bybit-node-producer.service -n 100 --no-pager
```

The Node writer refuses to start if the last persisted trade is absent from official recent REST, if
persisted unfinalized trades conflict with REST, or if the resumed public WS lacks post-anchor overlap. It
recovers only the verified bounded gap. Do not repeatedly restart through an unverified gap; use official
archive recovery under a separate reviewed procedure.

## E. Source freshness and controlled restart (administrator only)

After at least three new finalized 1m candles:

```sh
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-source-audit.js
sudo -u postgres psql -d btc_analysis -c "SELECT epoch_id,runtime_name,runtime_version,epoch_start,writer_role FROM bybit_live.node_producer_epochs ORDER BY epoch_start DESC LIMIT 3;"
sudo -u postgres psql -d btc_analysis -c "SELECT at,state,reason FROM bybit_live.operational_health_events ORDER BY event_id DESC LIMIT 12;"
```

Require `sourceFresh=true`, three consecutive current-epoch candles, `officialKlineExactMatches=3`, and
current Node `HEALTHY`. Inspect any `FAILED`/`DEGRADED` event; do not infer safety from one later `HEALTHY` row.
Only then test a controlled restart:

```sh
sudo systemctl restart bybit-node-producer.service
systemctl status bybit-node-producer.service --no-pager
journalctl -u bybit-node-producer.service -n 100 --no-pager
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-source-audit.js
```

Again require three new finalized candles and exact kline parity. The new epoch's `BACKFILLING` event must
record nonzero DB/REST/WS overlap and recovered count; any missing anchor is a hard failure. Verify no
unexpected duplicate/order/late-trade warnings and no historical UPDATE/DELETE. This restart has **not** been
performed by Codex.

## F. Frozen inference bundle and Shadow gate — only after E passes

The human policy transition is recorded in `reports/runtime/forward_shadow_runtime_approval_v1.json`, while
the older `runtime_start_authorized=false` artifact remains unchanged. This is conditional approval, **not**
evidence that the operational gates passed. No Shadow activation journal has been created, no live causal
inference audit has been run. The frozen Python worker has a **secret-free exporter** and passed the original
2022 model parity on both on-grid and off-grid samples. Its bundle has **not** been installed for `bybit_shadow`.
Do not copy the entire legacy research tree into `/opt`: an unrelated legacy module contains a DB credential.

Prepare and test a fresh bundle as the project owner, then have the administrator install only that bundle:

```sh
cd /home/minhyeok/app/cryptoTrade
python scripts/export-frozen-runtime.py --research-root /home/minhyeok/app/btcMarketData --dest /var/tmp/cryptoTrade-frozen-bundle
PYTHON_RESEARCH_ROOT=/home/minhyeok/app/btcMarketData PYTHON_RUNTIME_ROOT=/var/tmp/cryptoTrade-frozen-bundle PYTHON_BIN=/home/minhyeok/app/btcMarketData/.venv/bin/python node scripts/model-parity.mjs
sudo install -d -o root -g bybit_shadow -m 0750 /opt/cryptoTrade-frozen /opt/cryptoTrade-shadow /opt/cryptoTrade-python
sudo rsync -a /var/tmp/cryptoTrade-frozen-bundle/ /opt/cryptoTrade-frozen/
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-shadow/dist/
sudo install -o root -g bybit_shadow -m 0640 /home/minhyeok/app/cryptoTrade/package.json /home/minhyeok/app/cryptoTrade/package-lock.json /opt/cryptoTrade-shadow/
sudo install -d -o root -g bybit_shadow -m 0750 /opt/cryptoTrade-shadow/python
sudo install -o root -g bybit_shadow -m 0640 /home/minhyeok/app/cryptoTrade/python/frozen_inference_worker.py /opt/cryptoTrade-shadow/python/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-shadow ci --omit=dev --ignore-scripts
sudo /usr/bin/python3 -m venv /opt/cryptoTrade-python/venv
sudo /opt/cryptoTrade-python/venv/bin/pip install -r /home/minhyeok/app/cryptoTrade/deploy/frozen_runtime_requirements.txt
sudo chown -R root:bybit_shadow /opt/cryptoTrade-frozen /opt/cryptoTrade-shadow /opt/cryptoTrade-python
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-frozen /opt/cryptoTrade-shadow /opt/cryptoTrade-python
```

The administrator must verify the exported bundle contains no DB password, API key, training artifact or
unneeded research data. The application and inference subprocess use peer authentication with no DB password.
`/var/tmp/cryptoTrade-frozen-bundle` is a temporary deployment artifact; secure cleanup is an administrator
action after installation. Run the installed worker parity using `PYTHON_RUNTIME_BIN=/opt/cryptoTrade-python/venv/bin/python`
and `PYTHON_RUNTIME_ROOT=/opt/cryptoTrade-frozen` before proceeding. If it fails, stop here.

After E, use a fresh 5m finalized candle to audit causality as `bybit_shadow`. The following commands are
**preparation**, not evidence of PASS. The deployment environment file must be root-owned and group-readable
by `bybit_shadow`, contain absolute paths and SMTP settings, and must not contain exchange keys:

```sh
sudo -u bybit_shadow env PGUSER=bybit_shadow PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-shadow/dist/shadow-db-preflight.js
sudo systemd-run --unit=cryptoTrade-causal-audit --wait --collect -p User=bybit_shadow -p Group=bybit_shadow -p WorkingDirectory=/opt/cryptoTrade-shadow -p EnvironmentFile=/etc/cryptoTrade/shadow-runtime.env -p Environment=PGUSER=bybit_shadow -p Environment=PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-shadow/dist/shadow-inference-audit.js
```

The operational gate template at `deploy/shadow_operational_gate.template.json` is deliberately **NOT_RUN**.
Only the human operator may replace each field with `PASS` after observing the evidence, set a new activation
UUID and the current Node producer epoch UUID, and install it root-owned at
`/etc/cryptoTrade/shadow_operational_gate.json`. The file expires after one hour; an old epoch or incomplete
gate is rejected. Review `src/shadow/launch.ts` for the required environment variables
(`SHADOW_ACTIVATION_ID`, matching `SHADOW_LAUNCH_APPROVAL`, `SHADOW_POLICY_APPROVAL_PATH`,
`PYTHON_EXECUTABLE`, `PYTHON_RESEARCH_ROOT`, `BTCUSD_INVERSE_LOT_SIZE`), then install the separate Shadow unit.
Do **not** install or start it until the gate is complete. The activation command is:

```sh
sudo systemd-run --unit=cryptoTrade-shadow-activation --wait --collect -p User=bybit_shadow -p Group=bybit_shadow -p WorkingDirectory=/opt/cryptoTrade-shadow -p EnvironmentFile=/etc/cryptoTrade/shadow-runtime.env -p Environment=PGUSER=bybit_shadow -p Environment=PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-shadow/dist/shadow-activate.js
```

Activation must occur before the next 5m decision with at least 90 seconds lead. The persistent
Shadow service must then start before that decision, restore the activation, and process no earlier signal.
After activation, install and start the reviewed systemd unit (not before):

```sh
sudo install -o root -g root -m 0644 /home/minhyeok/app/cryptoTrade/deploy/bybit-node-shadow.service /etc/systemd/system/bybit-node-shadow.service
sudo systemctl daemon-reload
sudo systemctl enable --now bybit-node-shadow.service
systemctl status bybit-node-shadow.service --no-pager
journalctl -u bybit-node-shadow.service -n 100 --no-pager
```

Only after that verified handoff should hourly mail and the read-only API be checked. No real orders exist.

## G. Rollback and operational boundary

Python research/model/parity and rollback code are preserved. No automatic Python rollback is configured.
If the Node writer fails: stop/disable **Node** first; keep Shadow stopped; reconcile the DB tail; restore the
Python writer only after explicit operator approval and a verified non-overlapping writer handoff.
