import type pg from 'pg';
import { Decimal } from 'decimal.js';
import type { CanonicalCandle, CanonicalTrade } from '../../types/domain.js';

export class MarketRepository {
  constructor(private readonly pool: pg.Pool) {}
  async persist(candle: CanonicalCandle, trades: CanonicalTrade[]): Promise<void> {
    const client = await this.pool.connect();
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
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
