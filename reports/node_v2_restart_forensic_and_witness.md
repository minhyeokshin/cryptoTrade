# V2 controlled restart: read-only forensic and durable WS witness

Status: **blocked; do not start either producer or Shadow**. Approval `b6514764-b05a-4c9d-a845-9bc458aa9f96` and epoch `5767dba0-6453-408e-a331-0fc45fff7d18` are evidence, not permission for a new epoch. Pre-restart reported tail: `2026-10-08T08:32:59.332Z`, trade `8fb3b0a4-71c2-50f5-8c27-fabc499b9b2f`. The controlled restart at 17:34 KST failed with `Incomplete same-timestamp/sequence WS ordering witness`; systemd reported failed/stopped, `Restart=no`, `NRestarts=0`. Before restart the source was HEALTHY with three consecutive finalized candles and official kline parity 3/3. Those facts do **not** establish restart safety.

## Root cause and evidence boundary

`reconcileRecent()` verifies REST/WS IDs and payloads, but a REST-only member of a multi-trade `(MILLISECOND_TRUNCATED timestamp, seq)` group has no provable execution order after reconnect. It correctly fails closed. Bybit's [public trade specification](https://bybit-exchange.github.io/docs/v5/websocket/public/trade) says a futures WS message may contain multiple trades and several messages may have the same `seq`; its trade array is sorted by match time. Therefore `seq` and UUID lexical order are not individual trade ordinals. The earlier operator DB sample also contains many different trade IDs sharing one timestamp/sequence.

The 17:34 exception log did **not** persist the failing group's timestamp, sequence, IDs, prices, sizes, sides or original WS frame. Consequently `FAILING_GROUP=NOT_IDENTIFIED_FROM_AVAILABLE_EVIDENCE`; the reported anchor is not assumed to be the failing group. The enhanced read-only forensic command below prints the exact REST group, WS IDs, missing WS IDs, and persisted rows **if the current 1,000-trade REST window still covers the anchor**. If it has advanced, the original failure cannot be recreated from recent REST; mark it unverified rather than inventing a group. Neither current kline parity nor a new WS session reconstructs an old raw-trade order.

## Append-only design

Migration `005_node_ws_ordering_witness.sql` defines immutable raw public WS frames keyed by `(connection_id, message_ordinal)` and per-trade witnesses keyed by `trade_id`. Each witness records canonical timestamp, `seq`, price/size/side, message index, receive order, received time, exchange message ID and SHA-256 of the exact frame. A foreign key ties every witness to its canonical trade; a separate FK ties it to the raw frame. Both witness tables reject UPDATE/DELETE. An index on `(exchange_timestamp, exchange_sequence)` supports bounded group forensics; the per-trade FK's primary key provides the join index.

The Node WS adapter assigns order from the received publicTrade message and its array index. The repository verifies the frame hash and trade payload, then writes canonical trade, frame, witness, candle and HEALTHY event in one PostgreSQL transaction. Any witness conflict/missing write rolls the entire transaction back. Duplicate ID/payload is checked; existing rows are not updated or deleted. A restart checks persisted WS witnesses before promoting the tail. A legacy WS-origin row without a witness fails closed.

The design cannot recover WS frames that were **never durably recorded** in this V2 epoch, cannot prove order from REST array order, and cannot guarantee completeness of a network gap when REST's recent window has moved past it. An official raw archive may support a separately audited recovery if its ordering contract is established. Otherwise a new live epoch requires a new human approval ID and a separately recorded open gap; none is auto-created here. Migration/application and any later production restart require separate administrator approval. `RESTART_SAFETY=FAIL` for this controlled restart, regardless of unit-test success.

## Read-only verification and later admin gate

See [node_v2_restart_admin_verification.md](node_v2_restart_admin_verification.md). The forensic runtime uses Unix peer `bybit_producer` and `default_transaction_read_only=on`; it does not acquire a writer lease. It must be installed outside the active `/opt/cryptoTrade-runtime` path. The operator should preserve its JSON output, especially `failingGroup`, `persistedFailingGroup`, REST/WS order arrays and anchor coverage. No migration, service start, DB INSERT/UPDATE/DELETE, approval edit, or gap closure is part of this task.

## Verification

Local static/unit checks: lint, typecheck, test and build pass. The tests cover same-timestamp/sequence WS frame order, REST/WS mismatch fail-closed, missing witness, hash/payload validation, transaction rollback on witness failure, exact duplicate idempotency and no UPDATE/DELETE SQL. A true live read-only restart replay remains **not verified** until the peer-auth forensic command is run against a still-covered anchor (or an archived failure capture). New code does not make the existing V2 epoch automatically recoverable.
