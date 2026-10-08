import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Decimal } from 'decimal.js';
import { aggregate, endLabel } from '../dist/market/candle-builder.js';

const root = process.env.PYTHON_RESEARCH_ROOT;
const archive = process.env.PRE_PROSPECTIVE_ARCHIVE;
const python = process.env.PYTHON_BIN;
if (!root || !archive || !python || !archive.endsWith('/BTCUSD2026-09-30.csv.gz')) {
  throw new Error('Explicit Python root, Python binary and Sep30 archive required');
}
const limit = 5000;
const reference = JSON.parse(execFileSync(python,
  ['python/candle_reference.py', root, archive, String(limit)], { encoding: 'utf8', maxBuffer: 5_000_000 }));
let raw = '';
for await (const chunk of createReadStream(archive).pipe(createGunzip())) raw += chunk.toString();
const lines = raw.trim().split('\n');
const header = lines[0].split(',');
const at = (name) => header.indexOf(name);
const trades = lines.slice(1, limit + 1).map((line, index) => {
  const fields = line.split(',');
  return {
    id: fields[at('trdMatchID')], timestamp: new Decimal(fields[at('timestamp')]).mul(1000).floor().toNumber(),
    receivedAt: 0, side: fields[at('side')], price: fields[at('price')], size: fields[at('size')],
    sequence: null, source: 'WEBSOCKET', index,
  };
});
const ends = [...new Set(trades.map((t) => endLabel(t.timestamp)))].sort((a, b) => a - b);
let prior = trades[0].price;
let matches = 0;
for (const [i, end] of ends.entries()) {
  const node = aggregate(trades, end, prior);
  const py = reference.candles[i];
  if (!node || !py || node.end !== py.end || node.tradeCount !== py.tradeCount ||
      node.firstTradeTimestamp !== py.firstTradeTimestamp ||
      node.lastTradeTimestamp !== py.lastTradeTimestamp ||
      ['open', 'high', 'low', 'close', 'volume'].some((key) => !new Decimal(node[key]).eq(py[key]))) {
    throw new Error(`Python/Node candle mismatch at ${end}`);
  }
  prior = node.close;
  matches++;
}
if (matches !== reference.candles.length || trades.length !== reference.trades) throw new Error('Sample count mismatch');
process.stdout.write(JSON.stringify({ sample: archive, trades: trades.length, candles: matches,
  mismatches: 0, tolerance: 'exact Decimal equality' }) + '\n');
