/** Read-only, dedicated-role capture of the canonical tail and official public REST/WS boundary. */
import { userInfo } from 'node:os';
import { poolForReadOnlyRole } from './db/postgres.js';
import { MarketRepository } from './db/repositories/market.js';
import { officialOneMinute, recentTrades } from './market/bybit-rest.js';
import { BybitPublicWs } from './market/bybit-ws.js';
import { reconcileRecent } from './market/reconcile.js';
import type { CanonicalTrade } from './types/domain.js';
import { Decimal } from 'decimal.js';
import { sameTrade } from './market/trade-normalizer.js';

if (userInfo().username !== 'bybit_producer') throw new Error('bybit_producer OS user required');
const pool = poolForReadOnlyRole('bybit_producer');
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
  const candleRows = await pool.query<{ end_ms: string; open: string; high: string;
    low: string; close: string; volume: string; trade_count: string; source_status: string }>(
    `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS end_ms,
            open::text,high::text,low::text,close::text,volume::text,
            trade_count::text,source_status
       FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 20`);
  const candleParity = [];
  for (const row of candleRows.rows) {
    const official = await officialOneMinute(Number(row.end_ms));
    const differingFields = (['open', 'high', 'low', 'close', 'volume'] as const)
      .filter((field) => !new Decimal(row[field]).eq(official[field]));
    candleParity.push({ timestamp: new Date(Number(row.end_ms)).toISOString(),
      db: { open: row.open, high: row.high, low: row.low, close: row.close,
        volume: row.volume, tradeCount: row.trade_count, sourceStatus: row.source_status },
      official: { open: official.open, high: official.high, low: official.low,
        close: official.close, volume: official.volume }, differingFields });
  }
  const nextUnpersistedEnd = tail.lastCandleEnd + 60_000;
  const nextOfficial = nextUnpersistedEnd < Date.now() - 60_000 ?
    await officialOneMinute(nextUnpersistedEnd) : null;
  const healthRows = await pool.query<{ at: string; state: string; reason: string }>(
    `SELECT at::text,state,reason FROM bybit_live.operational_health_events
      ORDER BY event_id DESC LIMIT 30`);
  const lateRows = await pool.query<{ trade_id: string; exchange_timestamp: string;
    affected_candle: string; resolution: string }>(
    `SELECT trade_id,exchange_timestamp::text,affected_candle::text,resolution
       FROM bybit_live.late_trade_events ORDER BY event_id DESC LIMIT 30`);
  const epochTable = await pool.query<{ present: string | null }>(
    `SELECT to_regclass('bybit_live.node_producer_epochs')::text AS present`);
  let result: string;
  try {
    const reconciliation = reconcileRecent(tail.lastTrade, rest, [...buffered.values()],
      tail.anchorTimestampTrades);
    result = `PASS overlap=${reconciliation.overlap} recovered=${reconciliation.recovered.length}`;
  } catch (error) { result = `FAIL ${String(error)}`; }
  const anchor = tail.lastTrade;
  const restById = new Map(rest.map((trade) => [trade.id, trade]));
  const dbPriorWindow = dbWindow.rows.map((row, sourceIndex) => ({ tradeId: row.trade_id,
    timestamp: Number(row.timestamp_ms), price: row.price, size: row.size,
    side: row.side, sequence: row.raw_sequence === null ? null : Number(row.raw_sequence),
    sourceIndex }));
  const matches = dbPriorWindow.filter((row) => {
    const official = restById.get(row.tradeId);
    return official && sameTrade(official, { id: row.tradeId, timestamp: row.timestamp,
      side: row.side as CanonicalTrade['side'], price: row.price, size: row.size,
      sequence: row.sequence, receivedAt: 0, source: 'REST_RECENT' }) &&
      (row.sequence === null || official.sequence === null || row.sequence === official.sequence);
  });
  const groupCounts = new Map<number, number>();
  const sequenceCounts = new Map<string, number>();
  for (const row of dbPriorWindow) {
    groupCounts.set(row.timestamp, (groupCounts.get(row.timestamp) ?? 0) + 1);
    const key = `${row.timestamp}:${row.sequence ?? 'NULL'}`;
    sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1);
  }
  const details = (trades: CanonicalTrade[]) => trades
    .map((trade, sourceIndex) => ({ trade, sourceIndex }))
    .map(({ trade, sourceIndex }) => ({ tradeId: trade.id, timestamp: trade.timestamp,
      price: trade.price, size: trade.size, side: trade.side, sequence: trade.sequence,
      sourceIndex }));
  const sameMs = (trades: CanonicalTrade[]) => details(trades)
    .filter((trade) => trade.timestamp === anchor.timestamp);
  const restAnchorIndex = rest.findIndex((trade) => trade.id === anchor.id);
  process.stdout.write(`${JSON.stringify({ status: result, capturedAt: new Date().toISOString(),
    readOnly: true, canonicalWrites: 0, postgresReadOnlyEnforced: true,
    latestDbCandle: candleParity[0] ?? null, last20CandleParity: candleParity,
    nextUnpersistedCandle: { timestamp: new Date(nextUnpersistedEnd).toISOString(),
      official: nextOfficial, restTradeCount: rest.filter((trade) =>
        trade.timestamp >= tail.lastCandleEnd && trade.timestamp < nextUnpersistedEnd).length,
      restCoversMinuteStart: rest.some((trade) => trade.timestamp < tail.lastCandleEnd) },
    last30HealthEvents: healthRows.rows, last30LateTrades: lateRows.rows,
    nodeEpochTablePresent: epochTable.rows[0]?.present !== null,
    anchor: { tradeId: anchor.id,
      timestamp: anchor.timestamp, price: anchor.price, size: anchor.size,
      side: anchor.side, sequence: anchor.sequence },
    persistedSameMillisecond: sameMs(tail.anchorTimestampTrades),
    restSameMillisecond: sameMs(rest), wsSameMillisecond: sameMs([...buffered.values()]),
    restAnchorWindow: restAnchorIndex < 0 ? [] : details(rest).slice(
      Math.max(0, restAnchorIndex - 100), restAnchorIndex + 101),
    wsFirst200: details([...buffered.values()]).slice(0, 200),
    dbPriorWindow, anchor200RowMatches: matches.length,
    equalTimestampGroups: [...groupCounts.values()].filter((count) => count > 1).length,
    sameTimestampAndSequenceGroups: [...sequenceCounts.values()].filter((count) => count > 1).length,
    restRows: rest.length, wsRows: buffered.size,
    restOlderThanAnchor: rest.filter((trade) => trade.timestamp < anchor.timestamp).length,
    restPostAnchor: rest.filter((trade) => trade.timestamp > anchor.timestamp).length }, null, 2)}\n`);
} finally { ws.stop(); await pool.end(); }
