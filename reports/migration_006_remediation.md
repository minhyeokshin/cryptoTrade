# Migration 006 / Shadow fault isolation remediation

Code review only. Migration 006 was **not applied**; canonical data, approvals, Producer, Shadow, frozen Direction V1 and Policy A were not changed. `SHADOW_READY=FALSE`; live `RESTART_SAFETY=FAIL` remains.

## Contract

- Producer acquires `pg_try_advisory_lock(73142::integer,1001::integer)` on one dedicated `bybit_producer` `PoolClient`. Its canonical writes and heartbeat use that same client. A heartbeat now inserts only when that session's `pg_backend_pid()`, current database OID, `pg_stat_activity.backend_start`, and granted exclusive two-key advisory lock all match. A zero-row heartbeat fails and stops the local producer path.
- Shadow accepts the latest epoch heartbeat only when the latest boundary/epoch match, `RUNNING` heartbeat age is under 3 seconds, and `pg_locks` shows a granted exclusive advisory lock with the exact two-key tuple, **current database OID**, heartbeat PID, `bybit_producer` session user, and identical backend start. A different DB's same key, a new PID, or a reused PID with a different `backend_start` cannot satisfy the query. Missing `pg_stat_activity` visibility fails closed; the operator must verify that `bybit_shadow` can see `backend_start` for the producer peer session without broadening privileges automatically.
- Shadow rechecks source state on every public trade execution observation and every 1-second candle poll. Lock release/session exit is detected on the next check, not synchronously at the exact disconnect instant. Any query failure faults the runtime. A stale heartbeat is rejected.
- `activation_id` remains the suspension primary key. Identical replay is a no-op. A changed epoch, position or reason for the same activation ID throws. No suspension UPDATE/DELETE occurs. A failed durable suspension now reaches the runtime fault callback and stderr instead of being swallowed; the runtime remains faulted.

## Migration review and one-shot policy

`node_producer_heartbeats.epoch_id` and `node_shadow_suspensions.producer_epoch_id` are UUID FKs to `node_producer_epochs(epoch_id)` (UUID primary key). The Shadow runtime obtains its producer epoch ID from an existing live-epoch boundary, which itself references that producer-epoch table; the new FK is consistent with this contract. Both FK paths have indexes. The heartbeat table has an identity `BIGINT` sequence granted `USAGE, SELECT` to `bybit_producer`. Both tables have reject-UPDATE/DELETE triggers and dedicated SELECT/INSERT grants only. Shadow suspension has a UUID primary key and no sequence.

The repository has numbered SQL files but no proven DB migration ledger. `CREATE TABLE IF NOT EXISTS` does **not** verify an existing table's shape, and `CREATE TRIGGER` is intentionally one-shot. A DBA must inspect the live catalog and application history first, then apply only if absent through a separately authorized transaction. Never rerun 006 blindly or treat an existing relation as proof of the correct schema. No migration is executed in this task.

Read-only preflight examples for the DBA (use the dedicated peer roles where possible):

```sql
SELECT to_regclass('bybit_live.node_producer_heartbeats') AS heartbeats,
       to_regclass('shadow_trading_v1.node_shadow_suspensions') AS suspensions;
SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS data_type
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname,c.relname) IN (('bybit_live','node_producer_heartbeats'),
                                ('shadow_trading_v1','node_shadow_suspensions'))
   AND a.attnum > 0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum;
SELECT conrelid::regclass, conname, contype, confrelid::regclass
  FROM pg_catalog.pg_constraint
 WHERE conrelid IN ('bybit_live.node_producer_heartbeats'::regclass,
                    'shadow_trading_v1.node_shadow_suspensions'::regclass);
SELECT tgrelid::regclass, tgname, tgenabled
  FROM pg_catalog.pg_trigger
 WHERE tgrelid IN ('bybit_live.node_producer_heartbeats'::regclass,
                    'shadow_trading_v1.node_shadow_suspensions'::regclass)
   AND NOT tgisinternal;
```

The latter two queries are for **after** a separately authorized migration; before it exists, inspect `to_regclass` only. After apply, also verify table grants and the identity-sequence grant with `has_table_privilege` and `has_sequence_privilege`, and verify `bybit_shadow` sees the other peer session's `backend_start`. Reject broad `pg_read_all_stats` grants unless reviewed separately.

## Heartbeat retention

At 1 heartbeat/second, plan for about 31.5 million append-only rows/year. Monitor storage/index growth and identity headroom. For future data, review time partitioning and immutable cold-copy manifests; retain existing rows unchanged. No automated UPDATE/DELETE retention job is proposed.

Unit tests cover the lock key/DB OID/session-generation SQL contract, stale heartbeat and epoch gating, DB lookup failure, identical/conflicting suspension retries, and reporting of suspension-write failure. These tests are not a substitute for a dedicated-role PostgreSQL integration test or live restart validation.
