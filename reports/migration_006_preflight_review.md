# Migration 006 pre-application review (read-only)

Historical finding snapshot, now superseded by [Migration 006 remediation](migration_006_remediation.md). The code-level gaps identified below were addressed in the remediation commit; operational migration and role visibility are still unverified.

Verdict: **NOT READY**. No migration, production DB write, or service start was performed. Existing frozen model, feature, strategy, and canonical Policy A files were not changed.

## Findings

1. Producer heartbeat/session: `ProducerLease.acquire()` obtains the two-key session advisory lock `(73142,1001)` on a dedicated `PoolClient`. `startEpoch()`, canonical writes through `MarketRepository`, and `heartbeat()` use that client. `heartbeat()` stores `pg_backend_pid()` from the lock-owning session. Static path: PASS; live DB verification remains NOT RUN.
2. Shadow lock identity: `MarketReadRepository.sourceState()` compares lock type, `classid`, `objid`, `objsubid=2`, `granted`, and the heartbeat PID. It **does not compare `pg_locks.database` to the current database OID**. `pg_locks` is cluster-wide. A same-key advisory lock in another DB must not satisfy the predicate. Add an explicit database-OID check and a regression test before applying 006. To guard against backend PID reuse, also bind a heartbeat to the session's `backend_start` or another verifiable session generation, and check it at read time.
3. Failure inhibition: `sourceSnapshotFresh()` rejects a non-RUNNING, older-than-3-second heartbeat and `leaseHeld=false`. `ShadowMarketObserver` re-reads state before every public execution observation and every 1-second candle poll; failures fault the runtime. The runtime therefore blocks on its next check, **not synchronously at the instant a DB lock disappears**. Live failure/latency test is still required. With the database-OID issue outstanding, this cannot be certified PASS.
4. Suspension idempotency: `node_shadow_suspensions.activation_id` is a primary key and `suspend()` uses `ON CONFLICT DO NOTHING`. Repeated identical inserts do not create extra rows. A repeated activation ID with a *different* epoch, open position, or reason is silently ignored, however. Add conflict-payload verification and reject divergent repeats. No UPDATE is needed.
5. PID change: a new backend PID does not match the previous heartbeat PID, so old heartbeat fails the present predicate. It may become valid only after a new heartbeat from the new session. Backend PID reuse is not separately ruled out; store and compare a session-generation witness.
6. Migration 006: the heartbeat FK to `node_producer_epochs(epoch_id)`, identity sequence grant to `bybit_producer`, append-only triggers, and SELECT/INSERT grants are present in SQL. `node_shadow_suspensions.producer_epoch_id` has **no FK** to `node_producer_epochs(epoch_id)`; add one if all historical/reference semantics permit, plus an index on the referencing column. There is no sequence on the suspension table. The partial open-suspension index is appropriate for `WHERE open_position IS NOT NULL`, but it does not replace a producer-epoch FK index. Actual catalog/grant/trigger validation requires DBA read-only preflight after migration and was NOT RUN here.

## Append-only heartbeat retention proposal

At a 1-second interval, approximately 86,400 rows/day and 31.5 million rows/year are expected. Preserve existing rows unchanged. For future scale, create time-partitioned append-only storage in a separately reviewed migration, maintain per-partition row counts and SHA-256 manifests, copy closed partitions into immutable cold storage, and retain the database partitions or attached read-only archive without deleting historical heartbeat evidence. Monitor table/index size and sequence headroom. Do not introduce a retention DELETE/UPDATE job.

## Required before operational apply

- Fix and test database-OID plus session-generation matching of heartbeat and writer lock.
- Reject conflicting suspension replays for the same activation ID; test identical and divergent repeats.
- Resolve the suspension producer-epoch FK and referencing index in a new reviewed migration 006 revision.
- Run DBA read-only catalog verification for FK targets, enabled triggers, identity sequence grants, table grants, and no UPDATE/DELETE privilege; do not infer deployment state from the SQL file alone.
- Re-run lint, typecheck, tests, build, then test lock loss and PID change in an isolated PostgreSQL integration environment before any producer or Shadow start.

Current review: lint PASS; typecheck PASS; 129/129 tests PASS; build PASS. These tests do not cover the identified cross-database/PID-generation/payload-conflict cases.

`MIGRATION_006_READY=FALSE`; `SHADOW_READY=FALSE`; `RESTART_SAFETY=FAIL` (existing operational failure remains unresolved).
