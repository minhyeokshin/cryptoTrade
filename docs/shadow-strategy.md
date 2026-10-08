# Frozen strategy specification

Instrument: Bybit BTCUSD inverse perpetual. Decision: fully finalized causal 5-minute bar. Entry: frozen Direction `UP`→LONG or `DOWN`→SHORT only when actionable confidence is at least 0.55. One position maximum. Isolated margin is 20% of current equity, target notional 1.8 times that margin. Existing exit policy is opposite actionable `DIRECTION_FLIP`, otherwise five-minute `HORIZON`. Entry and exit each incur 5.5 bp taker fee and 2 bp adverse slippage. No stop-loss, averaging, pyramiding, or real order.

The pure engine is not a production-ready persistent engine: authoritative same-bar precedence, inverse contract quantity rounding, liquidation tier semantics, and DB-backed restart restoration require additional original-code parity and operational verification. No rule is to be inferred from backtest outcomes.
