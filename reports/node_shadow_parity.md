# Python → Node parity audit

| Check | Result | Evidence / tolerance |
| --- | --- | --- |
| Canonical millisecond timestamp | PASS | Exact deterministic unit fixture; tolerance 0 ms |
| Trade normalization | PASS | Deterministic fixture; exact identity/side/size/price |
| 1-minute candle | PASS (fixture only) | Prior-close and minute-boundary fixture; exact values |
| Full Python candle sample | NOT_RUN | Production sample comparison still required |
| Frozen feature schema | PASS (worker sample only) | Original Python feature builder; frozen schema hash exact |
| Frozen Direction prediction | PASS (one 2022 sample) | Original joblib vs worker: side exact, probability error 0, hashes exact |
| Inverse PnL/fees/slippage | PASS (two fixtures) | Original Python LONG and SHORT values; test tolerance 1e-9 |
| Persistent Shadow PnL | NOT_RUN | DB-backed lifecycle not implemented |

Parity probe uses only a 2022 Development sample and performs no training or prospective-period evaluation. Passing fixtures do not establish production parity or cutover readiness.
