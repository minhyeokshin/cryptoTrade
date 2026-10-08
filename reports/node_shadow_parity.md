# Python → Node parity audit

| Check | Result | Evidence / tolerance |
| --- | --- | --- |
| Canonical millisecond timestamp | PASS | Exact deterministic unit fixture; tolerance 0 ms |
| Trade normalization | PASS | Deterministic fixture; exact identity/side/size/price |
| 1-minute candle | PASS (fixture only) | Prior-close and minute-boundary fixture; exact values |
| Python candle archive sample | PASS | 2026-09-30 official archive, 5,000 trades / 388 minute aggregates; exact Decimal equality, 0 mismatch |
| Frozen feature schema | PASS (worker sample only) | Original Python feature builder; frozen schema hash exact |
| Frozen Direction prediction | PASS (one 2022 sample) | Original joblib vs worker: side exact, probability error 0, hashes exact |
| Inverse PnL/fees/slippage | PASS (two fixtures) | Original Python LONG and SHORT values; test tolerance 1e-9 |
| Persistent Shadow PnL | NOT_RUN | DB-backed lifecycle not implemented |

Model parity probe uses only a 2022 Development sample; candle parity uses only the pre-prospective 2026-09-30 official archive. Neither performs training or prospective-period evaluation. The final partial minute in the 5,000-trade candle sample is a formula-parity check, not a finalized operational candle. Passing these samples does not establish production cutover readiness.

To repeat the candle check after `npm run build`, set `PYTHON_RESEARCH_ROOT`, `PRE_PROSPECTIVE_ARCHIVE` (the Sep30 archive only), and `PYTHON_BIN`, then run `node scripts/candle-parity.mjs`.
