# Architecture and boundaries

`market` owns public BTCUSD inverse WebSocket parsing, public REST overlap, millisecond-truncated trade identity, and finalized trade-based candles. Official kline is a parity observation, not a replacement for canonical trade aggregation. `inference` isolates the original Python frozen model behind a long-running JSON-lines process. `shadow` contains pure inverse-contract execution and metrics logic. `api` and `report` are separate consumers.

The canonical writer is intentionally disabled in `main.ts`. The SQL repository is a prepared implementation only: it is not a verified production migration or a license to dual-write with the Python producer. Database connections require local Unix socket/peer authentication and dedicated producer/shadow roles. Append-only unique identities and relevant timestamp indexes follow the project's PostgreSQL least-privilege design.

`002_node_shadow_journal.sql` and `ShadowStateStore` prepare append-only, per-signal state snapshots with unique idempotency keys and an activation boundary. They have not been migrated to production, tested under the real Shadow peer role, or wired into the running engine. After a failed transaction, any future coordinator must reload the last committed snapshot before processing another signal.

`ShadowCoordinator` now enforces that commit boundary in unit tests: it exposes an entry/exit only after the journal commits, reloads committed state after a DB failure, and rejects duplicate signal replay. It still has no live prediction/candle consumer or operational DB-role test. The market runtime's bounded reconnect path requires the pre-disconnect trade ID in official recent REST plus exact post-anchor REST/WS trade overlap; an old anchor or ambiguous same-millisecond ordering leaves continuity blocked. This cannot recover an unbounded outage and does not replace official archive recovery.

Gaps before a verified activation timestamp are not part of a new forward epoch. A disconnect or failed reconciliation must block new entries. Model mismatch, stale candles, or unknown DB state must fail closed. No private exchange client exists.
