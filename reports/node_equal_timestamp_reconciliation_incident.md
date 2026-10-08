# Node producer equal-millisecond cutover incident (2026-10-08)

The Node writer remained fail-closed and was stopped. No canonical row was changed by this fix.
The operator's Python rollback is **not healthy** at this audit: `bybit-producer.service` was
enabled but repeatedly failed with `official OHLCV mismatch; no overwrite`; the Node service was
inactive/disabled. No new cutover is authorized while that source-integrity failure persists.

## Root cause and evidence

The old `reconcileRecent` treated every different trade ID with the same canonical millisecond
as the persisted anchor as potentially post-anchor and threw when its `seq` was equal/missing.
This ignored the possibility that the trade was already persisted in the anchor millisecond bucket.
`MILLISECOND_TRUNCATED` is unchanged. The synthetic regression fixture reproduces that exact
error condition, but the production REST/WS payloads were not retained in the journal; the exact
production IDs and 200-row window have **not** been reconstructed yet.

Bybit's [public trade WebSocket specification](https://bybit-exchange.github.io/docs/v5/websocket/public/trade)
states that a message's trade array is sorted by match time and that multiple messages may share
the same cross-sequence (`seq`). The [recent public-trades API](https://bybit-exchange.github.io/docs/v5/market/recent-trade)
exposes `execId`, millisecond `time`, and `seq`, but does not promise a total order for equal
timestamp/sequence executions. A UUID trade ID is an identity, **not** a lexical order key.

The legacy Python `gap_recovery.recover_recent` verifies the anchor ID is in the 1,000-row REST
window and exact payload for REST/WS duplicates, then sorts by timestamp/seq/trade ID. An isolated
Python fixture with anchor+peer at the same timestamp/seq returned `complete=True` with all four
fixture trade IDs. The new Node
rule is intentionally narrower: it verifies the full persisted anchor millisecond group by ID,
payload and available sequence; skips those existing trades; accepts a new same-millisecond trade
only with a strictly higher unique exchange sequence. Unknown/tied ordering, an incomplete REST
page, conflicting ID/payload/sequence, or absent post-anchor REST/WS overlap still fails closed.
It does not lexically order IDs or mutate stored timestamps. Thus the accepted Node set is no
looser than the tested Python behavior, but the two implementations are not behavior-identical.
The expanded Node regression suite passed 84/84 unit tests, lint, typecheck and build locally.

The bounded 180-second Node `DRY_RUN` (while the Python service remained the only potential DB
writer) exited on the expected timeout with `connected=true`, `sourceFresh=true`,
`lastRestWsOverlap=1`, `orderingViolations=0`, `duplicateCount=0`, `integrityFault=false`,
two finalized dry-run candles, and `canonicalWrites=0`. This public-only mode does **not**
open the canonical DB or prove the persisted-anchor comparison. Do not treat it as a cutover PASS.

## Read-only production forensics (administrator)

The following captures the current DB anchor, up to 200 prior canonical trades, the current
REST page and a 20-second public WS buffer. It does not recreate the already-lost failure-time
snapshot. Run after installing the fixed `dist/` but **before** changing writer service states:

```sh
sudo -u bybit_producer env PGUSER=bybit_producer PGDATABASE=btc_analysis /usr/bin/node /opt/cryptoTrade-runtime/dist/producer-reconcile-forensics.js
```

Require an exact anchor ID/payload, full anchor bucket parity, an older REST timestamp proving
the bucket is not truncated, a post-anchor REST/WS overlap, and no ambiguity/conflict. Review
the emitted `sourceIndex` fields rather than sorting IDs. A failure or current canonical tail
outside the REST 1,000-trade window requires official archive reconciliation, not a forced start.

## Retest and administrator handoff

1. Keep `bybit-node-producer.service` stopped/disabled. Diagnose Python's official OHLCV mismatch
   without overwriting any canonical candle. Capture current DB tail and official kline parity.
2. Install this commit's compiled Node `dist/` under `/opt/cryptoTrade-runtime`, preserving peer
   ownership. Run the read-only forensic command above as `bybit_producer`.
3. With Python as the only writer, run Node `DRY_RUN` for at least 180 seconds and inspect final
   JSON: connected, nonzero REST/WS overlap, freshness, zero writes. This alone does not prove
   DB-anchor reconciliation; the forensic command does.
4. Before re-cutover, require the Python producer healthy and advancing, Node inactive, and no
   Node canonical writes. Verify no unclosed current gap. Follow the staged exclusive-writer
   instructions in `reports/node_full_cutover_admin.md` only after all these are PASS.
5. Stop/disable Python immediately before Node WRITE startup. If Node fails, leave it stopped;
   any Python rollback requires a new explicit, non-overlapping handoff and its own OHLCV parity.

No inference, Shadow activation, actual order, private API or API key is involved in this fix.
