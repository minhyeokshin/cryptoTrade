/** Read-only, dedicated-role capture of the canonical tail and official public REST/WS boundary. */
import { userInfo } from 'node:os';
import { poolForRole } from './db/postgres.js';
import { MarketRepository } from './db/repositories/market.js';
import { recentTrades } from './market/bybit-rest.js';
import { BybitPublicWs } from './market/bybit-ws.js';
import { reconcileRecent } from './market/reconcile.js';
import type { CanonicalTrade } from './types/domain.js';

if (userInfo().username !== 'bybit_producer') throw new Error('bybit_producer OS user required');
const pool = poolForRole('bybit_producer');
const ws = new BybitPublicWs();
const buffered = new Map<string, CanonicalTrade>();
ws.on('trade', (trade: CanonicalTrade) => buffered.set(trade.id, trade));
try {
  const tail = await new MarketRepository(pool).recoveryTail();
  ws.start();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, 20_000);
    ws.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
  });
  if (!ws.connected || !buffered.size) throw new Error('Read-only forensic WS unavailable');
  const rest = await recentTrades();
  const dbWindow = await pool.query<{ trade_id: string; timestamp_ms: string;
    price: string; size: string; side: string; raw_sequence: string | null }>(
    `SELECT trade_id,(extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS timestamp_ms,
            price::text,size::text,side,raw_sequence::text
       FROM bybit_live.bybit_live_trades
      WHERE exchange_timestamp <= to_timestamp($1::double precision/1000)
      ORDER BY exchange_timestamp DESC,raw_sequence DESC NULLS LAST LIMIT 200`,
    [tail.lastTrade.timestamp]);
  let result: string;
  try {
    const reconciliation = reconcileRecent(tail.lastTrade, rest, [...buffered.values()],
      tail.anchorTimestampTrades);
    result = `PASS overlap=${reconciliation.overlap} recovered=${reconciliation.recovered.length}`;
  } catch (error) { result = `FAIL ${String(error)}`; }
  const anchor = tail.lastTrade;
  const details = (trades: CanonicalTrade[]) => trades
    .map((trade, sourceIndex) => ({ trade, sourceIndex }))
    .map(({ trade, sourceIndex }) => ({ tradeId: trade.id, timestamp: trade.timestamp,
      price: trade.price, size: trade.size, side: trade.side, sequence: trade.sequence,
      sourceIndex }));
  const sameMs = (trades: CanonicalTrade[]) => details(trades)
    .filter((trade) => trade.timestamp === anchor.timestamp);
  const restAnchorIndex = rest.findIndex((trade) => trade.id === anchor.id);
  process.stdout.write(`${JSON.stringify({ status: result, capturedAt: new Date().toISOString(),
    readOnly: true, canonicalWrites: 0, anchor: { tradeId: anchor.id,
      timestamp: anchor.timestamp, price: anchor.price, size: anchor.size,
      side: anchor.side, sequence: anchor.sequence },
    persistedSameMillisecond: sameMs(tail.anchorTimestampTrades),
    restSameMillisecond: sameMs(rest), wsSameMillisecond: sameMs([...buffered.values()]),
    restAnchorWindow: restAnchorIndex < 0 ? [] : details(rest).slice(
      Math.max(0, restAnchorIndex - 100), restAnchorIndex + 101),
    wsFirst200: details([...buffered.values()]).slice(0, 200),
    dbPriorWindow: dbWindow.rows.map((row, sourceIndex) => ({ tradeId: row.trade_id,
      timestamp: Number(row.timestamp_ms), price: row.price, size: row.size,
      side: row.side, sequence: row.raw_sequence === null ? null : Number(row.raw_sequence),
      sourceIndex })),
    restRows: rest.length, wsRows: buffered.size,
    restOlderThanAnchor: rest.filter((trade) => trade.timestamp < anchor.timestamp).length,
    restPostAnchor: rest.filter((trade) => trade.timestamp > anchor.timestamp).length }, null, 2)}\n`);
} finally { ws.stop(); await pool.end(); }
