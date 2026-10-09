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

  async liveEpochId(): Promise<string> {
    const result = await this.pool.query<{ epoch_id: string }>(
      `SELECT epoch_id::text FROM bybit_live.node_live_epoch_boundaries
        ORDER BY recorded_at DESC,approval_id DESC LIMIT 1`);
    const epochId = result.rows[0]?.epoch_id;
    if (!epochId) throw new Error('Verified live producer epoch unavailable');
    return epochId;
  }

  async liveEpochBoundary(): Promise<number> {
    const result = await this.pool.query<{ ms: string }>(
      `SELECT (extract(epoch FROM first_complete_minute_start)*1000)::bigint::text AS ms
         FROM bybit_live.node_live_epoch_boundaries
        ORDER BY recorded_at DESC,approval_id DESC LIMIT 1`);
    const ms = Number(result.rows[0]?.ms);
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('Verified new live epoch boundary unavailable');
    return ms;
  }

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
    latestCandleStatus: string | null; health: string | null; healthAt: number | null;
    producerEpochId: string | null; boundaryEpochId: string | null;
    firstCompleteMinuteStartMs: number | null;
    heartbeatAt: number | null; heartbeatState: string | null; leaseHeld: boolean }> {
    const [trade, candle, health, producer] = await Promise.all([
      this.pool.query<{ ms: string }>(
        `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS ms
           FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1`),
      this.pool.query<{ ms: string; source_status: string }>(
        `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS ms, source_status
           FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1`),
      this.pool.query<{ state: string; at_ms: string }>(
        `SELECT state, (extract(epoch FROM at)*1000)::bigint::text AS at_ms
           FROM bybit_live.operational_health_events ORDER BY event_id DESC LIMIT 1`),
      this.pool.query<{ epoch_id: string | null; boundary_epoch_id: string | null;
        first_complete_minute_start_ms: string | null;
        heartbeat_ms: string | null; heartbeat_state: string | null; lease_held: boolean }>(
        `WITH latest_boundary AS (
           SELECT epoch_id,first_complete_minute_start FROM bybit_live.node_live_epoch_boundaries
            ORDER BY recorded_at DESC,approval_id DESC LIMIT 1
         )
         SELECT h.epoch_id::text, b.epoch_id::text AS boundary_epoch_id,
           (extract(epoch FROM b.first_complete_minute_start)*1000)::bigint::text
             AS first_complete_minute_start_ms,
           (extract(epoch FROM h.at)*1000)::bigint::text AS heartbeat_ms,
           h.state AS heartbeat_state,
           bybit_live.producer_writer_session_verified() AS lease_held
           FROM latest_boundary b
           LEFT JOIN LATERAL (
             SELECT epoch_id,at,state FROM bybit_live.node_producer_heartbeats
              WHERE epoch_id=b.epoch_id ORDER BY id DESC LIMIT 1
           ) h ON true`),
    ]);
    const state = { latestTrade: trade.rows[0] ? Number(trade.rows[0].ms) : null,
      latestCandle: candle.rows[0] ? Number(candle.rows[0].ms) : null,
      latestCandleStatus: candle.rows[0]?.source_status ?? null,
      health: health.rows[0]?.state ?? null,
      healthAt: health.rows[0] ? Number(health.rows[0].at_ms) : null,
      producerEpochId: producer.rows[0]?.epoch_id ?? null,
      boundaryEpochId: producer.rows[0]?.boundary_epoch_id ?? null,
      firstCompleteMinuteStartMs: producer.rows[0]?.first_complete_minute_start_ms ?
        Number(producer.rows[0].first_complete_minute_start_ms) : null,
      heartbeatAt: producer.rows[0]?.heartbeat_ms ? Number(producer.rows[0].heartbeat_ms) : null,
      heartbeatState: producer.rows[0]?.heartbeat_state ?? null,
      leaseHeld: producer.rows[0]?.lease_held === true };
    if ([state.latestTrade, state.latestCandle, state.healthAt, state.heartbeatAt,
      state.firstCompleteMinuteStartMs].some((value) =>
      value !== null && !Number.isSafeInteger(value))) throw new Error('Invalid persisted source timestamp');
    return state;
  }
}
