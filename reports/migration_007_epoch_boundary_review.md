# Migration 007 Epoch/Boundary contract review

Operator read-only evidence: latest `node_producer_epochs.epoch_id` is `7ed1eed8-096b-4007-a642-ec4f34271cf1`, while the latest approved `node_live_epoch_boundaries.epoch_id` is `dff8316a-f21d-4093-9b97-98100e706dee`. The IDs do not match. The reported V4 controlled restart failed after an earlier healthy start.

## Root cause and interpretation

The prior `main.ts` generated and inserted a fresh Producer Epoch row **on every WRITE/NEW_LIVE_EPOCH startup, before** `MarketRuntime.start()` performed persisted-anchor reconciliation. A failed restart therefore legitimately leaves a newer append-only attempt row without a new approved boundary. This is an expected *failure record*, not evidence that the historical Boundary should be updated or that the gap was closed. No existing Epoch or Boundary row is deleted or rewritten.

The earlier Migration 007 function selected the latest Epoch row and required it to equal the latest Boundary. That correctly rejected the reported failed attempt, but it would also reject a later successful ordinary WRITE restart because that path created yet another Epoch without a new Boundary. The Shadow reader made the same mistaken latest-Epoch assumption. An old `HEALTHY` event alone cannot authorize Shadow, but the contract needed a legitimate restart path.

## Revised contract (code only)

- A **new, unused human-approved live epoch** acquires the writer advisory lock, inserts one Epoch row, proves current REST/WS overlap, then records its immutable Boundary. Before that Boundary exists, the verifier returns false. No Shadow entry can be enabled by an unapproved or failed attempt.
- An **ordinary WRITE restart** acquires the lock, selects the latest approved Boundary joined to its existing Epoch, verifies any supplied approval ID is that latest one, and binds the new Producer *DB session* to that existing epoch ID. It does **not** insert a new Epoch row. Strict persisted-anchor/witness reconciliation and `BACKFILLING` health still run before any fresh RUNNING heartbeat.
- The Migration 007 Boolean verifier selects the latest approved Boundary, its corresponding Producer Epoch and latest heartbeat for **that exact epoch**, then checks current DB OID, fixed advisory key, `bybit_producer` PID and `backend_start`, RUNNING state and heartbeat age. Failed newer Epoch rows remain in the audit trail but cannot be treated as the approved Producer. A lock held by a failed/unbound epoch or a stale prior heartbeat returns false.
- The Shadow reader derives `producerEpochId` from the latest heartbeat tied to that approved Boundary. It does not use `ORDER BY node_producer_epochs.epoch_start DESC`. Missing heartbeat, stale health, boundary mismatch, missing lock, or any query error fails closed.

This change does **not** repair the controlled-restart raw ordering witness failure. A WRITE restart may still fail strict reconciliation; it must remain stopped in that case. `NORMAL_STARTUP_COMPATIBILITY=CODE_PASS_NOT_LIVE_VERIFIED`, not an operational restart PASS.

No migration was applied, no operating DB row was inserted/updated/deleted, and neither Producer nor Shadow was started. Frozen Direction V1, strategy and canonical Policy A are unchanged. `SHADOW_READY=FALSE`; `RESTART_SAFETY=FAIL`.
