import type pg from 'pg';
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
              Number(row.price) !== Number(trade.price) || Number(row.size) !== Number(trade.size)) {
            throw new Error('Conflicting persisted trade ID');
          }
        }
      }
      await client.query(
        `INSERT INTO bybit_live.bybit_live_candles_1m
          (timestamp,open,high,low,close,volume,trade_count,first_trade_timestamp,
           last_trade_timestamp,finalized_at,source_status)
         VALUES (to_timestamp($1::double precision/1000),$2,$3,$4,$5,$6,$7,
           CASE WHEN $8::double precision IS NULL THEN NULL ELSE to_timestamp($8::double precision/1000) END,
           CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9::double precision/1000) END,
           clock_timestamp(),'LIVE_CURRENT_EPOCH')`,
        [candle.end,candle.open,candle.high,candle.low,candle.close,candle.volume,
          candle.tradeCount,candle.firstTradeTimestamp,candle.lastTradeTimestamp]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
