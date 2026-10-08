# V2 Producer approval validation fix — deployment is not authorized here

The `NODE_CURRENT_LIVE_EPOCH` artifact authorizes a **market Producer epoch only**. Its `forward_shadow_may_start_after_new_epoch_health_pass` field is required to be a boolean but is **not** a Producer start gate. An explicitly human-approved V2 artifact with that field `false` is valid for the Producer. Shadow remains a separate runtime role and approval gate; this change does not call or start it.

Unchanged fail-closed checks: distinct syntactically valid `approval_id` and `previous_approval_id`, `approved_by_human=true`, parsable `approved_at`, parsable `expected_gap_start` that must equal the current DB trade tail at startup, `historical_gap_may_remain_open=true`, `new_live_epoch_authorized=true`, `actual_orders_allowed=false`, `private_api_allowed=false`, and root ownership with no group/world write bit on the installed approval file. An approval ID already present in `node_live_epoch_boundaries` cannot create another new boundary: startup routes to strict `WRITE` reconciliation and still fails if the old anchor cannot be proven.

The source and deployed `/opt/cryptoTrade-runtime/dist` were reported to differ. The service is not started here, and the deployed binary and human approval file are not changed. Because `/opt/cryptoTrade-runtime` is not traversable by the current user, **administrator verification is required**. Do not infer deployment parity from passing local tests.

## Administrator read-only parity commands

Run after reviewing the commit and building the exact checked-out branch; these commands do not start a service or change the operating runtime:

```sh
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
git status --short --branch
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
sha256sum dist/market/new-live-epoch-approval.js
sudo sha256sum /opt/cryptoTrade-runtime/dist/market/new-live-epoch-approval.js
sudo diff -qr /home/minhyeok/app/cryptoTrade/dist /opt/cryptoTrade-runtime/dist
```

`sudo diff -qr` must exit **0 with no differences** to certify that **every deployed `dist` file and the file set** match the just-built source. A different hash or any `diff` output means the old binary is still deployed; do not start it. The operator may stage/review an exact deployment separately, then rerun `sudo diff -qr` and require exit 0 before any approved start. Do not edit the approval artifact to satisfy the old binary.

The approved V2 artifact can be inspected without exposing secrets:

```sh
sudo stat -c '%U %G %a %n' /etc/cryptoTrade/node_new_live_epoch_approval.json
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -Atc "BEGIN READ ONLY; SELECT to_char(exchange_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1; COMMIT;"
```

The operator must independently compare the DB tail with the approved artifact's `expected_gap_start` and verify that the approval ID is unused. The old artifact and DB rows remain unchanged. No service start, Shadow start, canonical mutation, actual order, or private API call is performed by this fix. `RESTART_SAFETY=NOT_VERIFIED` until a later supervised restart test.
