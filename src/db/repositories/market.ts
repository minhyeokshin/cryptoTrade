import type pg from 'pg';
import { Decimal } from 'decimal.js';
import type { CanonicalCandle, CanonicalTrade } from '../../types/domain.js';
import type { ProducerLease } from '../producer-lease.js';

export class MarketRepository {
  constructor(private readonly pool: pg.Pool, private readonly lease?: ProducerLease) {}
  async historicalGapStart(): Promise<number> {
    const result = await (this.lease?.client ?? this.pool).query<{ ms: string }>(
      `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS ms
         FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1`);
    const ms = Number(result.rows[0]?.ms);
    if (!Number.isSafeInteger(ms)) throw new Error('Canonical historical gap start unavailable');
    return ms;
  }
  async newEpochApprovalUsed(approvalId: string): Promise<boolean> {
    const result = await (this.lease?.client ?? this.pool).query(
      `SELECT 1 FROM bybit_live.node_live_epoch_boundaries WHERE approval_id=$1::uuid LIMIT 1`,
      [approvalId]);
    return result.rowCount === 1;
  }
  async recoveryTail(): Promise<{ lastCandleEnd: number; previousClose: string;
    lastTrade: CanonicalTrade; anchorTimestampTrades: CanonicalTrade[];
    unfinalizedTrades: CanonicalTrade[] }> {
    const client = this.lease?.client ?? await this.pool.connect();
    try {
      const candle = await client.query<{ end_ms: string; close: string }>(
        `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS end_ms,close::text
           FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1`);
      const tradeColumns = `trade_id,
        (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS timestamp_ms,
        (extract(epoch FROM received_at)*1000)::bigint::text AS received_ms,
        side,price::text,size::text,raw_sequence::text AS sequence`;
      type Row = { trade_id: string; timestamp_ms: string; received_ms: string;
        side: string; price: string; size: string; sequence: string | null };
      const tail = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          ORDER BY exchange_timestamp DESC,raw_sequence DESC NULLS LAST,trade_id DESC LIMIT 1`);
      if (!candle.rows[0] || !tail.rows[0]) throw new Error('Canonical producer tail unavailable');
      const end = Number(candle.rows[0].end_ms);
      const recent = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          WHERE exchange_timestamp >= to_timestamp($1::double precision/1000)
          ORDER BY exchange_timestamp,raw_sequence NULLS LAST,trade_id LIMIT 1001`, [end]);
      if (recent.rows.length > 1000) throw new Error('Unfinalized canonical tail exceeds bounded recovery');
      const sameTimestamp = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          WHERE exchange_timestamp = to_timestamp($1::double precision/1000)
          ORDER BY raw_sequence NULLS LAST LIMIT 1001`, [tail.rows[0].timestamp_ms]);
      if (sameTimestamp.rows.length > 1000) throw new Error('Anchor millisecond group exceeds bounded recovery');
      const normalize = (row: Row): CanonicalTrade => {
        const timestamp = Number(row.timestamp_ms);
        const receivedAt = Number(row.received_ms);
        const sequence = row.sequence === null ? null : Number(row.sequence);
        if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(receivedAt) ||
            (sequence !== null && !Number.isSafeInteger(sequence)) ||
            (row.side !== 'Buy' && row.side !== 'Sell') ||
            !new Decimal(row.price).gt(0) || !new Decimal(row.size).gt(0)) {
          throw new Error('Invalid persisted producer trade tail');
        }
        return { id: row.trade_id, timestamp, receivedAt, side: row.side,
          price: row.price, size: row.size, sequence, source: 'REST_RECENT' };
      };
      if (!Number.isSafeInteger(end) || end % 60_000 !== 0 ||
          !new Decimal(candle.rows[0].close).gt(0)) throw new Error('Invalid canonical candle tail');
      return { lastCandleEnd: end, previousClose: candle.rows[0].close,
        lastTrade: normalize(tail.rows[0]), anchorTimestampTrades: sameTimestamp.rows.map(normalize),
        unfinalizedTrades: recent.rows.map(normalize) };
    } finally { if (!this.lease) client.release(); }
  }
  async persist(candle: CanonicalCandle, trades: CanonicalTrade[],
                health?: 'WARMING' | 'HEALTHY' | 'STALE' | 'DEGRADED'): Promise<void> {
    const client = this.lease?.client ?? await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const trade of trades) {
        const result = await client.query<{ trade_id: string }>(
          `INSERT INTO bybit_live.bybit_live_trades
            (trade_id,exchange_timestamp,received_at,side,price,size,raw_sequence,source)
           VALUES ($1,to_timestamp($2::double precision/1000),to_timestamp($3::double precision/1000),$4,$5,$6,$7,$8)
           ON CONFLICT (trade_id) DO NOTHING RETURNING trade_id`,
          [trade.id, trade.timestamp, trade.receivedAt, trade.side, trade.price, trade.size,
            trade.sequence, trade.source]);
        if (!result.rowCount) {
          const old = await client.query<{ ts_ms: number; side: string; price: string; size: string }>(
            `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint AS ts_ms,
                    side,price::text,size::text FROM bybit_live.bybit_live_trades WHERE trade_id=$1`, [trade.id]);
          const row = old.rows[0];
          if (!row || Number(row.ts_ms) !== trade.timestamp || row.side !== trade.side ||
              !new Decimal(row.price).eq(trade.price) || !new Decimal(row.size).eq(trade.size)) {
            throw new Error('Conflicting persisted trade ID');
          }
        }
      }
      const inserted = await client.query(
        `INSERT INTO bybit_live.bybit_live_candles_1m
          (timestamp,open,high,low,close,volume,trade_count,first_trade_timestamp,
           last_trade_timestamp,finalized_at,source_status)
         VALUES (to_timestamp($1::double precision/1000),$2,$3,$4,$5,$6,$7,
           CASE WHEN $8::double precision IS NULL THEN NULL ELSE to_timestamp($8::double precision/1000) END,
           CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9::double precision/1000) END,
           clock_timestamp(),'LIVE_CURRENT_EPOCH')
         ON CONFLICT (timestamp) DO NOTHING RETURNING timestamp`,
        [candle.end,candle.open,candle.high,candle.low,candle.close,candle.volume,
          candle.tradeCount,candle.firstTradeTimestamp,candle.lastTradeTimestamp]);
      if (!inserted.rowCount) {
        const old = await client.query<{ open: string; high: string; low: string; close: string;
          volume: string; trade_count: string; first_ms: string | null; last_ms: string | null }>(
          `SELECT open::text,high::text,low::text,close::text,volume::text,trade_count::text,
                  (extract(epoch FROM first_trade_timestamp)*1000)::bigint::text AS first_ms,
                  (extract(epoch FROM last_trade_timestamp)*1000)::bigint::text AS last_ms
             FROM bybit_live.bybit_live_candles_1m
            WHERE timestamp=to_timestamp($1::double precision/1000)`, [candle.end]);
        const row = old.rows[0];
        if (!row || !new Decimal(row.open).eq(candle.open) || !new Decimal(row.high).eq(candle.high) ||
            !new Decimal(row.low).eq(candle.low) || !new Decimal(row.close).eq(candle.close) ||
            !new Decimal(row.volume).eq(candle.volume) || Number(row.trade_count) !== candle.tradeCount ||
            (row.first_ms === null ? null : Number(row.first_ms)) !== candle.firstTradeTimestamp ||
            (row.last_ms === null ? null : Number(row.last_ms)) !== candle.lastTradeTimestamp) {
          throw new Error('Conflicting persisted candle timestamp');
        }
      }
      if (health) await client.query(
        `INSERT INTO bybit_live.operational_health_events (state,reason)
         VALUES ($1,$2)`, [health, 'cryptoTrade-node canonical candle committed']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { if (!this.lease) client.release(); }
  }

  async recordFailure(reason: string): Promise<void> {
    if (!this.lease) return;
    await this.recordStartupHealth('FAILED', reason);
  }

  async recordStartupHealth(state: 'BACKFILLING' | 'FAILED', reason: string): Promise<void> {
    if (!this.lease) return;
    await this.lease.client.query(
      `INSERT INTO bybit_live.operational_health_events (state,reason)
       VALUES ($1,$2)`, [state, `cryptoTrade-node: ${reason.slice(0, 300)}`]);
  }
}
