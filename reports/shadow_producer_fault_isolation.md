# Forward Shadow producer-failure isolation — implementation review

The canonical Producer's policy A and `reconcileRecent()` are unchanged. The V4 REST-only pair is absent from canonical DB and has no WS witness, per operator evidence. The 268 WS frames and 570 witnesses already stored remain untouched. This change does not repair that gap or make restart safe.

## Isolation contract

- [Migration 006](../src/db/migrations/006_producer_shadow_isolation.sql) is **prepared, not applied**. It defines an append-only Producer heartbeat emitted from the same PostgreSQL session that holds the canonical writer advisory lock, plus an append-only Shadow suspension record. Neither table allows UPDATE/DELETE. Dedicated-role grants only.
- Producer emits a heartbeat every second while running, with its epoch ID, lock-owning backend PID, and `RUNNING`/`DEGRADED`/`FAILED` state. A heartbeat failure stops the local market runtime and releases the writer lease. Missing migration blocks the Producer preflight before market startup.
- Shadow source readiness requires **all** of: latest operational health `HEALTHY`, current canonical trade/candle freshness, heartbeat `RUNNING` younger than 3 seconds, a live advisory lock held by that heartbeat's backend PID, latest producer epoch matching the latest approved live boundary, and the separately approved Shadow operational-gate epoch. The gate is now actually read and validated at launch. Missing table, lock, heartbeat, boundary, or approval fails closed.
- Before a public trade can execute a pending prediction, Shadow re-reads that Producer state; callbacks are serialized so DB check latency cannot reorder causal public trades. It still executes on the first valid public trade after the finalized 5m decision, not on a candle-derived synthetic price.
- A missing/delayed candle faults the observer. A runtime fault stops inference/public observation, creates no retroactive trades and does not settle an open virtual position. It appends a `node_shadow_suspensions` record containing the unresolved position, and the read-only API reports `SUSPENDED` with current equity/PnL withheld. If DB is unavailable, the process remains faulted and the latest journal snapshot with an open position blocks later activation; durable fault recording must be verified operationally.
- A suspended activation cannot auto-resume. Any new activation requires separate root-owned operational approval and full post-epoch frozen warmup. An unresolved open position blocks another activation until an independently approved accounting resolution exists; no automatic close or arbitrary exit price is implemented.

## Verification and limits

Unit tests cover healthy producer entry, lock loss before public execution, stale heartbeat, epoch mismatch, candle gap, open-position suspension, blocked automatic resume, and read-only API withholding. Lint, typecheck, tests, and build pass locally. This is **not** a live restart-safety PASS: migration 006 is unapplied, services were not started, and V4 canonical recovery remains fail-closed. Operator review of migration/grants, a separate dry-run integration test, and renewed human approval are prerequisites to any deployment.

The advisory-lock read and the subsequent in-memory action cannot be made one atomic cross-process transaction; the code rechecks on every trade and candle poll, but a Producer crash in that tiny interval is a residual timing risk. No claim of instantaneous process-death detection beyond the next check is made. A failed suspension insert due to DB outage likewise requires operator forensic resolution; it never authorizes a price-based settlement.

`PRODUCER_FAILURE_INHIBITION=IMPLEMENTED_NOT_LIVE_VERIFIED`; `SHADOW_EPOCH_ISOLATION=IMPLEMENTED_NOT_LIVE_VERIFIED`; `GAP_RECOVERY_POLICY=FAULT_AND_NEW_APPROVAL`; `OPEN_POSITION_SUSPENSION=IMPLEMENTED_NOT_LIVE_VERIFIED`; `SHADOW_READY=FALSE`; `RESTART_SAFETY=FAIL`; `ACTUAL_ORDERS=0`; `PRIVATE_API_CALLS=0`.
