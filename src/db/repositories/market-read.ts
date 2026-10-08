import { Decimal } from 'decimal.js';
import type pg from 'pg';
import type { CanonicalCandle } from '../../types/domain.js';

type CandleRow = { end_ms: string; open: string; high: string; low: string; close: string;
  volume: string; trade_count: string; first_ms: string | null; last_ms: string | null };

function canonicalCandle(row: CandleRow): CanonicalCandle {
  const end = Number(row.end_ms);
  const tradeCount = Number(row.trade_count);
  const first = row.first_ms === null ? null : Number(row.first_ms);
  const last = row.last_ms === null ? null : Number(row.last_ms);
  const fields = [row.open, row.high, row.low, row.close, row.volume].map((value) => new Decimal(value));
  if (!Number.isSafeInteger(end) || end % 60_000 !== 0 || !Number.isSafeInteger(tradeCount) ||
      tradeCount < 0 || fields.some((value) => !value.isFinite()) ||
      fields.slice(0, 4).some((value) => !value.gt(0)) || fields[4]!.lt(0) ||
      fields[1]!.lt(Decimal.max(fields[0]!, fields[3]!)) ||
      fields[2]!.gt(Decimal.min(fields[0]!, fields[3]!)) ||
      (tradeCount === 0) !== (first === null && last === null) ||
      (tradeCount === 0 ? !fields[4]!.eq(0) : !fields[4]!.gt(0)) ||
      (first !== null && last !== null &&
        (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
          first < end - 60_000 || last >= end || first > last))) {
    throw new Error('Invalid persisted canonical candle');
  }
  return { end, open: row.open, high: row.high, low: row.low, close: row.close,
    volume: row.volume, tradeCount,
    firstTradeTimestamp: first, lastTradeTimestamp: last };
}

const columns = `
  (extract(epoch FROM timestamp)*1000)::bigint::text AS end_ms,
  open::text,high::text,low::text,close::text,volume::text,trade_count::text,
  (extract(epoch FROM first_trade_timestamp)*1000)::bigint::text AS first_ms,
  (extract(epoch FROM last_trade_timestamp)*1000)::bigint::text AS last_ms`;

/** SELECT-only repository for the dedicated bybit_shadow peer role. */
export class MarketReadRepository {
  constructor(private readonly pool: pg.Pool) {}

  async warmupBefore(cutoffMs: number, limit = 11_999): Promise<CanonicalCandle[]> {
    if (!Number.isSafeInteger(cutoffMs) || !Number.isInteger(limit) || limit < 1 || limit > 12_000) {
      throw new Error('Invalid warmup range');
    }
    const result = await this.pool.query<CandleRow>(
      `SELECT ${columns} FROM bybit_live.bybit_live_candles_1m
        WHERE timestamp < to_timestamp($1::double precision/1000)
        ORDER BY timestamp DESC LIMIT $2`, [cutoffMs, limit]);
    return result.rows.reverse().map(canonicalCandle);
  }

  async finalizedAfter(lastEndMs: number, limit = 100): Promise<CanonicalCandle[]> {
    if (!Number.isSafeInteger(lastEndMs) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid candle cursor');
    }
    const result = await this.pool.query<CandleRow>(
      `SELECT ${columns} FROM bybit_live.bybit_live_candles_1m
        WHERE timestamp > to_timestamp($1::double precision/1000)
        ORDER BY timestamp ASC LIMIT $2`, [lastEndMs, limit]);
    return result.rows.map(canonicalCandle);
  }

  async sourceState(): Promise<{ latestTrade: number | null; latestCandle: number | null;
    health: string | null }> {
    const [trade, candle, health] = await Promise.all([
      this.pool.query<{ ms: string }>(
        `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS ms
           FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1`),
      this.pool.query<{ ms: string }>(
        `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS ms
           FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1`),
      this.pool.query<{ state: string }>(
        `SELECT state FROM bybit_live.health_events ORDER BY event_id DESC LIMIT 1`),
    ]);
    return { latestTrade: trade.rows[0] ? Number(trade.rows[0].ms) : null,
      latestCandle: candle.rows[0] ? Number(candle.rows[0].ms) : null,
      health: health.rows[0]?.state ?? null };
  }
}
