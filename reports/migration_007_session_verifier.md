# Migration 007: least-privilege Producer session verification

Status: **code prepared, not applied**. Operator evidence confirms that `bybit_shadow` can see Producer PID `3512472` and username but receives `NULL` for its `pg_stat_activity.backend_start`; the administrator sees `2026-10-09 06:50:51.719838+00`. The direct Shadow query therefore fails closed even when the Producer session is healthy.

## Design

Migration [007](../src/db/migrations/007_producer_session_verifier.sql) creates the zero-argument `bybit_live.producer_writer_session_verified()` function. It returns one Boolean, never a PID, timestamp, raw row, or caller-selected lock key. Its reviewed `postgres` owner can see the Producer's session start; `bybit_shadow` receives only EXECUTE on this function, not `pg_read_all_stats`. Migration execution requires `current_user=postgres` and sets owner explicitly. Function creation, PUBLIC revoke and `bybit_shadow` grant occur in one transaction.

The `SECURITY DEFINER` function fixes `search_path=pg_catalog, pg_temp`, schema-qualifies referenced objects, and rejects non-`bybit_shadow` login sessions. It verifies the **latest approved live boundary's** Producer epoch and latest heartbeat for that exact epoch, `RUNNING` state younger than three seconds, current DB OID, `bybit_producer` client backend PID **and** `backend_start`, and a granted exclusive two-integer advisory lock `(73142,1001)` held by that backend. Failed newer Epoch rows remain append-only evidence but cannot substitute for a boundary. A same-key lock in another database, old/reused PID, absent session, stale heartbeat or released lock returns false. Shadow's existing `sourceSnapshotFresh()` and per-trade/per-poll checks remain fail-closed; the repository now calls only the restricted Boolean function. See [Epoch/Boundary review](migration_007_epoch_boundary_review.md).

The application Shadow preflight also checks that the installed function is owned by `postgres`, is SECURITY DEFINER/VOLATILE/PARALLEL UNSAFE, uses the fixed search path, is executable by `bybit_shadow` but not PUBLIC, and that `bybit_shadow` has not received `pg_read_all_stats`. Missing or misconfigured Migration 007 prevents Shadow startup.

## DBA review before any separate approval to apply

1. Confirm the reviewed admin owner is `postgres` and that `bybit_live.producer_writer_session_verified()` does not already exist. This is a **one-shot**, non-rerunnable migration; do not use `CREATE OR REPLACE` to overwrite an existing security boundary.
2. Review the function body and complete transaction, including `REVOKE ... FROM PUBLIC` before COMMIT and the exact `bybit_shadow` grant. No grant to Producer, research roles or PUBLIC is intended.
3. After a separately authorized application, inspect `pg_proc`, `pg_namespace`, `pg_get_functiondef`, `aclexplode`, and `has_function_privilege` under a read-only transaction; run `producer:db-preflight` and `shadow:db-preflight` as their dedicated peer roles. Confirm unrelated roles receive permission denied and `bybit_shadow` cannot read the Producer's raw `backend_start` directly.
4. In an isolated integration window, prove `TRUE` only for a current Producer holding the exact lock and fresh heartbeat; prove `FALSE` for lock release/session exit, stale heartbeat, changed backend generation and a same-key lock in another database. Existing approval/start gates remain closed throughout this review.

Unit/static tests cover the restricted SQL contract and fail-closed repository behavior. They do **not** substitute for dedicated-role PostgreSQL integration or live restart validation. No Migration 007 application, canonical DB change, Producer/Shadow start, approval edit, model/strategy change, order or private API call was performed.

`SESSION_VISIBILITY_ROOT_CAUSE=CONFIRMED`; `MIGRATION_007_READY=CODE_READY_NOT_APPLIED`; `SHADOW_READY=FALSE`; `RESTART_SAFETY=FAIL`.
