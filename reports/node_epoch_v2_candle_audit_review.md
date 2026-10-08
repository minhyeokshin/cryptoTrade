# Node Epoch V2 candle audit review — no production mutation

## Evidence and conclusion

Operator read-only audit reported `lastDbTradeMatch=true`, `lastCandleMatch=true`, `klineParity=true`, `rawAggregation=true`, `oldGapRecord=true`, `approvalIdDistinct=true`, `expectedGapStartMatch=true`, `v2AlreadyUsed=false`, but `openChain=false`. DB and [official Bybit inverse 1m kline](https://bybit-exchange.github.io/docs/v5/market/kline) matched **3/3 exact OHLCV** for canonical end labels 07:01, 07:02 and 07:03 UTC. No DB row was changed.

The Python `scripts/bybit_live/candle_builder.py` and Node `src/market/candle-builder.ts` agree: candle `open=verified previous close`, `high=max(open, raw prices)`, `low=min(open, raw prices)`, `volume=sum(raw size)`, `trade_count=number of raw trades`. An empty minute is not silently forward-filled: it is accepted only with official public zero-volume kline verification. Tied millisecond/sequence trades retain witnessed arrival order; their UUIDs are not a sort key. We did not modify either builder.

The three reported raw maxima (82772.9, 82730.5, 82700.1) are below the respective carried opens (82786, 82736.8, 82706.9). Thus the observed DB highs are exactly `max(open, raw max)` and the differences are **normal under the frozen builder contract**, not evidence of missing trades by themselves. The operator's `rawAggregation=true` additionally covers trade count, summed size, low/high with carried open, and a defensible close witness. The official 06:59-start public kline, which ends at 07:00, has close **82786**, matching the 07:01 candle open.

## Why `openChain=false` cannot yet be called a DB fault

The prior audit required `preceding.rows[0]` at canonical end 07:00 before checking the three-candle chain. It reported only a boolean, so **the exact branch is not in the supplied output**: either the 07:00 DB candle is absent, or it exists with a close unequal to 82786. The later chain is independently supported by 3/3 official OHLCV: 07:02 open equals 07:01 close and 07:03 open equals 07:02 close.

For the *first complete minute* of a new live epoch, the prior candle can intentionally be absent across an OPEN historical gap. The runtime seeds `previousClose` from the official public prior-minute kline at `first_complete_minute_start`; it does not insert an artificial previous candle. If the existing boundary's `first_complete_minute_start` is 07:00 and the 07:00 DB candle is absent, an official 07:00-end close of 82786 is the correct chain witness, and the old audit's `openChain=false` is a **false negative**. If the boundary is different, the official seed is unavailable, or an adjacent DB candle exists but conflicts, the audit must still FAIL. The OPEN gap record itself is required policy evidence, not a reason to fail the chain.

The updated read-only audit reports the preceding DB row, official predecessor close, boundary timestamp, `openChainCheck.seedSource`, and an explicit reason. It only accepts an official seed when the append-only boundary exactly identifies the first complete minute; otherwise it fails closed. The builder's OHLCV rules and all canonical rows remain unchanged.

## Read-only confirmation and rerun

Before calling the old epoch PASS, the operator must inspect these two facts (peer auth, read-only):

```sh
sudo -u bybit_producer psql -X -v ON_ERROR_STOP=1 -d btc_analysis -c "BEGIN READ ONLY; SELECT timestamp,close FROM bybit_live.bybit_live_candles_1m WHERE timestamp='2026-10-08 07:00:00+00'; SELECT approval_id,first_complete_minute_start,historical_source_gap FROM bybit_live.node_live_epoch_boundaries WHERE approval_id='90c276e6-f9d6-457b-a659-d8e3d254116a'; COMMIT;"
```

Build and install the revised audit **only under `/opt/cryptoTrade-forensic`**, then run the read-only command in [the administrator handoff](node_epoch_v2_post_approval_admin.md). Do not replace `/opt/cryptoTrade-runtime/dist`, install a unit, or start either producer. Require `openChainCheck.pass=true`, `seedSource=OFFICIAL` with boundary 07:00 and no DB predecessor, **or** `seedSource=DB` with an exact adjacent DB close and no official conflict. Require all other audit flags to remain true and sampled duplicate counts zero. A real predecessor mismatch remains FAIL. `NEW_EPOCH_V2_APPROVAL_READY` is not asserted until this rerun passes; human approval and production restart safety remain separate gates.

## Current gate

`CANDLE_BUILDER_CONTRACT=PYTHON_NODE_MATCH` · `RAW_HIGH_DIFFERENCE_ROOT_CAUSE=CARRIED_OPEN` · `RAW_AGGREGATION=PASS (operator audit)` · `OPEN_CHAIN_FALSE_ROOT_CAUSE=PREDECESSOR_REQUIRED_BY_OLD_AUDIT; DB ABSENCE VS MISMATCH NOT YET CONFIRMED` · `OLD_EPOCH_INTEGRITY=NOT_VERIFIED` · `NEW_EPOCH_V2_APPROVAL_READY=FALSE` · `RESTART_SAFETY=NOT_VERIFIED` · `PRODUCERS=STOPPED` · `FORWARD_SHADOW_STARTED=FALSE` · `ACTUAL_ORDERS=0` · `PRIVATE_API_CALLS=0`.
