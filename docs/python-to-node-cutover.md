# Python → Node cutover (requires separate human approval)

1. Inspect Python producer process, DB role and last canonical trade/candle. Do not stop it during development.
2. Run Node in `DRY_RUN`/`READ_ONLY` against public data; check trade IDs, millisecond timestamp, candle and inference parity.
3. Verify complete current-epoch continuity, frozen hashes, database grants, contract rounding and restart/idempotency tests.
4. Confirm Node dependencies and configuration under the dedicated OS/database role.
5. In an approved maintenance window, stop the Python canonical writer, verify it has stopped, then enable the Node writer through a separately reviewed code change. Never run two canonical writers.
6. Check first trade and first three finalized candles against official public sources; check duplicate/order counts and freshness.
7. Perform a controlled restart and verify last event restoration, duplicate prevention and no historical mutation.
8. On failure, stop Node writer and restore the Python writer only after reconciling the common anchor. Never overwrite canonical rows.

Current state: steps 3–8 have not been performed; Node write mode refuses to start.
