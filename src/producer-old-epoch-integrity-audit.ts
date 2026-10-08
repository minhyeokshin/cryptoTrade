/** Read-only, bounded audit for the three completed candles of the stopped Node epoch. */
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Decimal } from 'decimal.js';
import { poolForReadOnlyRole } from './db/postgres.js';
import { officialOneMinute } from './market/bybit-rest.js';

if (userInfo().username !== 'bybit_producer') throw new Error('bybit_producer OS user required');
const old = JSON.parse(readFileSync('reports/runtime/node_new_live_epoch_approval_v1.json', 'utf8')) as Record<string, unknown>;
const pending = JSON.parse(readFileSync('reports/runtime/node_new_live_epoch_approval_v2.pending.json', 'utf8')) as Record<string, unknown>;
const pool = poolForReadOnlyRole('bybit_producer');
const ends = ['2026-10-08T07:01:00.000Z', '2026-10-08T07:02:00.000Z',
  '2026-10-08T07:03:00.000Z'];
const eq = (a: string, b: string): boolean => new Decimal(a).eq(new Decimal(b));
type CandleRow = { open: string; high: string; low: string; close: string;
  volume: string; trade_count: string };
type RawRow = { trades: string; volume: string | null; high: string | null;
  low: string | null; last_timestamp: Date | null };
type AuditRow = { candleEnd: string; db: CandleRow | null;
  official: Awaited<ReturnType<typeof officialOneMinute>>; raw: RawRow | null;
  lastTimestampGroup: { distinct_prices: string; prices: string[] } | null;
  klineExact: boolean; rawAggregateMatch: boolean;
  closeOrderProvable: boolean; rawCloseMatch: boolean };
try {
  const tail = await pool.query<{ trade_id: string; exchange_timestamp: Date; raw_sequence: string }>(
    `SELECT trade_id,exchange_timestamp,raw_sequence::text FROM bybit_live.bybit_live_trades
       ORDER BY exchange_timestamp DESC LIMIT 1`);
  const lastCandle = await pool.query<{ timestamp: Date }>(
    `SELECT timestamp FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1`);
  const preceding = await pool.query<{ close: string }>(
    `SELECT close::text FROM bybit_live.bybit_live_candles_1m
      WHERE timestamp=to_timestamp($1::double precision/1000)`,
    [Date.parse('2026-10-08T07:00:00Z')]);
  const anchor = tail.rows[0];
  const lastDbTradeMatch = anchor?.trade_id === '944d1e11-80f8-5560-a97b-d14d93a252d0' &&
    anchor.exchange_timestamp.toISOString() === '2026-10-08T07:02:54.737Z' &&
    anchor.raw_sequence === '118887018575';
  const results: AuditRow[] = [];
  for (const iso of ends) {
    const end = Date.parse(iso);
    const db = await pool.query<CandleRow>(
      `SELECT open::text,high::text,low::text,close::text,volume::text,trade_count::text
         FROM bybit_live.bybit_live_candles_1m
        WHERE timestamp=to_timestamp($1::double precision/1000)`, [end]);
    const raw = await pool.query<RawRow>(
      `SELECT count(*)::text AS trades,sum(size)::text AS volume,max(price)::text AS high,
              min(price)::text AS low,max(exchange_timestamp) AS last_timestamp
         FROM bybit_live.bybit_live_trades
        WHERE exchange_timestamp>=to_timestamp($1::double precision/1000)
          AND exchange_timestamp<to_timestamp($2::double precision/1000)`, [end - 60_000, end]);
    const official = await officialOneMinute(end);
    const row = db.rows[0];
    const aggregate = raw.rows[0];
    const klineExact = !!row && (['open', 'high', 'low', 'close', 'volume'] as const)
      .every((field) => eq(row[field], official[field]));
    // Open includes previous close in the frozen builder. High/low therefore include the
    // stored open; close within a tied last group needs original WS batch-order evidence.
    const rawAggregateMatch = !!row && !!aggregate && aggregate.volume !== null &&
      aggregate.high !== null && aggregate.low !== null &&
      row.trade_count === aggregate.trades && eq(row.volume, aggregate.volume) &&
      eq(row.high, Decimal.max(row.open, aggregate.high).toString()) &&
      eq(row.low, Decimal.min(row.open, aggregate.low).toString());
    const lastGroup = aggregate?.last_timestamp ? await pool.query<{ distinct_prices: string; prices: string[] }>(
      `SELECT count(DISTINCT price)::text AS distinct_prices,array_agg(DISTINCT price::text) AS prices
         FROM bybit_live.bybit_live_trades WHERE exchange_timestamp=$1`,
      [aggregate.last_timestamp]) : null;
    const closeOrderProvable = lastGroup?.rows[0]?.distinct_prices === '1';
    const rawCloseMatch = closeOrderProvable && !!row &&
      lastGroup!.rows[0]!.prices.some((price) => eq(price, row.close));
    results.push({ candleEnd: iso, db: row ?? null, official,
      raw: aggregate ?? null, lastTimestampGroup: lastGroup?.rows[0] ?? null,
      klineExact, rawAggregateMatch, closeOrderProvable, rawCloseMatch });
  }
  const boundaries = await pool.query<{ approval_id: string; historical_source_gap: string;
    gap_start: Date; gap_end: Date }>(
    `SELECT approval_id::text,historical_source_gap,gap_start,gap_end
       FROM bybit_live.node_live_epoch_boundaries
      WHERE approval_id=$1::uuid OR approval_id=$2::uuid`, [old.approval_id, pending.approval_id]);
  const samples = await pool.query<{ sample: string; rows: string; unique_rows: string }>(
    `WITH t AS (SELECT trade_id FROM bybit_live.bybit_live_trades
                  ORDER BY exchange_timestamp DESC LIMIT 1000),
          c AS (SELECT timestamp FROM bybit_live.bybit_live_candles_1m
                  ORDER BY timestamp DESC LIMIT 20)
     SELECT 'trade_ids' AS sample,count(*)::text AS rows,
            count(DISTINCT trade_id)::text AS unique_rows FROM t
     UNION ALL
     SELECT 'candle_timestamps',count(*)::text,count(DISTINCT timestamp)::text FROM c`);
  const oldGap = boundaries.rows.find((row) => row.approval_id === old.approval_id &&
    row.historical_source_gap === 'OPEN');
  const lastCandleMatch = lastCandle.rows[0]?.timestamp.toISOString() === ends[2];
  const expectedGapStartMatch = pending.expected_gap_start === anchor?.exchange_timestamp.toISOString();
  const approvalIdDistinct = pending.approval_id !== old.approval_id;
  const v2AlreadyUsed = boundaries.rows.some((row) => row.approval_id === pending.approval_id);
  const uniqueSamples = samples.rows.length === 2 && samples.rows.every((row) =>
    row.rows === row.unique_rows) && samples.rows.some((row) =>
    row.sample === 'trade_ids' && row.rows === '1000') && samples.rows.some((row) =>
    row.sample === 'candle_timestamps' && row.rows === '20');
  const klineParity = lastCandleMatch && results.every((row) => row.klineExact);
  const rawAggregation = results.every((row) => row.rawAggregateMatch && row.rawCloseMatch);
  const openChain = !!preceding.rows[0] && results.every((row, index) => !!row.db &&
    eq(row.db.open, index === 0 ? preceding.rows[0]!.close : results[index - 1]!.db!.close));
  const oldEpochIntegrity = lastDbTradeMatch && klineParity && rawAggregation && !!oldGap &&
    uniqueSamples && openChain;
  process.stdout.write(`${JSON.stringify({ readOnly: true, canonicalWrites: 0,
    lastDbTradeMatch, lastCandleMatch, klineParity, rawAggregation,
    oldGapRecord: !!oldGap, oldGap: oldGap ?? null,
    approvalIdDistinct, expectedGapStartMatch, pendingApproval: true, v2AlreadyUsed,
    canonicalSamples: samples.rows, uniqueSamples, openChain,
    oldEpochIntegrity, newEpochV2ApprovalReady: oldEpochIntegrity && approvalIdDistinct &&
      expectedGapStartMatch && !v2AlreadyUsed,
    anchor: anchor ?? null, lastCandle: lastCandle.rows[0] ?? null,
    candles: results }, null, 2)}\n`);
  if (!oldEpochIntegrity || !approvalIdDistinct || !expectedGapStartMatch || v2AlreadyUsed)
    process.exitCode = 2;
} finally { await pool.end(); }
