"""Read-only Python reference for Node parity; no DB, model or prospective data."""
import csv
import gzip
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1])
    archive = Path(sys.argv[2])
    limit = int(sys.argv[3])
    if archive.name != 'BTCUSD2026-09-30.csv.gz':
        raise SystemExit('Only pre-prospective 2026-09-30 archive permitted')
    sys.path.insert(0, str(root / 'scripts' / 'bybit_live'))
    from candle_builder import Trade, aggregate, end_label  # type: ignore[import-not-found]

    trades = []
    with gzip.open(archive, 'rt', newline='') as handle:
        for i, row in enumerate(csv.DictReader(handle)):
            if i >= limit:
                break
            ms = int((Decimal(row['timestamp']) * 1000).to_integral_value(rounding=ROUND_FLOOR))
            timestamp = datetime.fromtimestamp(ms / 1000, timezone.utc)
            trades.append(Trade(row['trdMatchID'], timestamp, timestamp, row['side'],
                                Decimal(row['price']), Decimal(row['size'])))
    if not trades:
        raise SystemExit('Empty sample')
    prior = trades[0].price
    result = []
    for end in sorted({end_label(t.exchange_timestamp) for t in trades}):
        candle = aggregate(trades, end, prior)
        if candle is None:
            continue
        prior = candle['close']
        result.append({
            'end': int(end.timestamp() * 1000),
            'open': str(candle['open']), 'high': str(candle['high']),
            'low': str(candle['low']), 'close': str(candle['close']),
            'volume': str(candle['volume']), 'tradeCount': candle['trade_count'],
            'firstTradeTimestamp': int(candle['first_trade_timestamp'].timestamp() * 1000),
            'lastTradeTimestamp': int(candle['last_trade_timestamp'].timestamp() * 1000),
        })
    print(json.dumps({'trades': len(trades), 'candles': result}, separators=(',', ':')))


if __name__ == '__main__':
    main()
