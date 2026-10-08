# Administrator-only V2 restart verification (not a cutover authorization)

Keep both producers stopped and disabled. Do not start Shadow. Do not apply migration `005` or replace the active runtime as part of this read-only forensic step.

```sh
systemctl is-active bybit-producer.service bybit-node-producer.service
systemctl is-enabled bybit-producer.service bybit-node-producer.service
pgrep -af 'blind_capture_daemon[.]py|/opt/cryptoTrade-runtime/dist/main[.]js' || true
cd /home/minhyeok/app/cryptoTrade
git switch feature/node-forward-shadow
git status --short
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
```

The expected producer state is inactive/disabled with no matching process. Stop if any writer is active. An administrator may stage the built diagnostic separately; these commands do not install a unit or touch the active runtime:

```sh
sudo install -d -o root -g bybit_producer -m 0750 /opt/cryptoTrade-forensic /opt/cryptoTrade-forensic/dist
sudo rsync -a /home/minhyeok/app/cryptoTrade/dist/ /opt/cryptoTrade-forensic/dist/
sudo install -o root -g bybit_producer -m 0640 /home/minhyeok/app/cryptoTrade/package.json /home/minhyeok/app/cryptoTrade/package-lock.json /opt/cryptoTrade-forensic/
sudo /usr/bin/npm --prefix /opt/cryptoTrade-forensic ci --omit=dev --ignore-scripts
sudo chown -R root:bybit_producer /opt/cryptoTrade-forensic
sudo chmod -R g+rX,o-rwx /opt/cryptoTrade-forensic
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-forensic/dist/producer-restart-forensics.js
```

The final command makes only public REST/WS requests and read-only peer-auth DB queries. Review `anchorTrade`, `restOlderThanAnchor`, `restWsOverlap`, `sameSequenceGroups`, `failingGroup` and `persistedFailingGroup`. A zero older-than-anchor count, absent anchor, incomplete group or inconsistent payload is a **FAIL**, not a reason to bypass the check. Current REST data may no longer contain the 17:34 failure; in that case report `FAILING_GROUP=NOT_RECOVERABLE_FROM_RECENT_SOURCE` and keep both writers off. Save the JSON outside the canonical DB for audit.

For a **future**, separately approved deployment, the DBA must first review/apply `src/db/migrations/005_node_ws_ordering_witness.sql` through a controlled migration transaction and verify append-only triggers/role grants. Only then can a newly built binary write durable witnesses. Existing V2 WS trades have no raw-frame witness and are deliberately not backfilled or assumed safe. Any new-epoch route requires a distinct human approval artifact; no command here starts an epoch or closes a historical gap.
