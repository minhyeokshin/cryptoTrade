import { Decimal } from 'decimal.js';
import type pg from 'pg';
import type { CanonicalCandle } from '../types/domain.js';
import { officialOneMinute } from './bybit-rest.js';

type EpochRow = { epoch_id: string; start_ms: string };
type TradeRow = { ms: string };
type CandleRow = { end_ms: string; open: string; high: string; low: string; close: string;
  volume: string; source_status: string };
type HealthRow = { state: string; reason: string; at_ms: string };

export interface ProducerSourceAudit {
  epochId: string | null;
  latestTradeTimestamp: number | null;
  latestCandleTimestamp: number | null;
  lastThreeConsecutive: boolean;
  officialKlineExactMatches: number;
  health: string | null;
  sourceFresh: boolean;
}

function sameValues(row: CandleRow, official: CanonicalCandle): boolean {
  return (['open', 'high', 'low', 'close', 'volume'] as const)
    .every((key) => new Decimal(row[key]).eq(official[key]));
}

/** Operational-only audit: no features, labels, inference, performance or DB writes. */
export async function auditProducerSource(pool: pg.Pool, now = Date.now(),
  official: (end: number) => Promise<CanonicalCandle> = officialOneMinute): Promise<ProducerSourceAudit> {
  const epochResult = await pool.query<EpochRow>(
    `SELECT epoch_id::text,
            (extract(epoch FROM epoch_start)*1000)::bigint::text AS start_ms
       FROM bybit_live.node_producer_epochs ORDER BY epoch_start DESC LIMIT 1`);
  const epoch = epochResult.rows[0];
  if (!epoch) return { epochId: null, latestTradeTimestamp: null, latestCandleTimestamp: null,
    lastThreeConsecutive: false, officialKlineExactMatches: 0, health: null, sourceFresh: false };
  const [tradeResult, candleResult, healthResult] = await Promise.all([
    pool.query<TradeRow>(
      `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS ms
         FROM bybit_live.bybit_live_trades
        WHERE exchange_timestamp >= to_timestamp($1::double precision/1000)
        ORDER BY exchange_timestamp DESC LIMIT 1`, [epoch.start_ms]),
    pool.query<CandleRow>(
      `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS end_ms,
              open::text,high::text,low::text,close::text,volume::text,source_status
         FROM bybit_live.bybit_live_candles_1m
        WHERE timestamp >= to_timestamp($1::double precision/1000)
        ORDER BY timestamp DESC LIMIT 3`, [epoch.start_ms]),
    pool.query<HealthRow>(
      `SELECT state,reason,(extract(epoch FROM at)*1000)::bigint::text AS at_ms
         FROM bybit_live.operational_health_events ORDER BY event_id DESC LIMIT 1`),
  ]);
  const tradeAt = tradeResult.rows[0] ? Number(tradeResult.rows[0].ms) : null;
  const candles = candleResult.rows;
  const candleAt = candles[0] ? Number(candles[0].end_ms) : null;
  const health = healthResult.rows[0];
  const consecutive = candles.length === 3 && candles.every((row, i) =>
    row.source_status === 'LIVE_CURRENT_EPOCH' && Number.isSafeInteger(Number(row.end_ms)) &&
    (i === 0 || Number(candles[i - 1]!.end_ms) - Number(row.end_ms) === 60_000));
  let matches = 0;
  if (consecutive) {
    for (const row of candles) {
      const officialCandle = await official(Number(row.end_ms));
      if (sameValues(row, officialCandle)) matches++;
    }
  }
  const recent = (value: number | null) => value !== null && Number.isSafeInteger(value) &&
    value <= now && now - value < 180_000;
  const healthAt = health ? Number(health.at_ms) : null;
  return { epochId: epoch.epoch_id, latestTradeTimestamp: tradeAt,
    latestCandleTimestamp: candleAt, lastThreeConsecutive: consecutive,
    officialKlineExactMatches: matches, health: health?.state ?? null,
    sourceFresh: consecutive && matches === 3 && recent(tradeAt) && recent(candleAt) &&
      recent(healthAt) && health?.state === 'HEALTHY' &&
      health.reason.startsWith('cryptoTrade-node') };
}
