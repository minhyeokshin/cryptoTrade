import { Decimal } from 'decimal.js';
import type { CanonicalCandle } from '../types/domain.js';
import { MINUTE } from './candle-builder.js';

export type AuditCandle = Pick<CanonicalCandle, 'end' | 'open' | 'high' | 'low' |
  'close' | 'volume' | 'tradeCount'>;
export type RawMinuteSummary = { tradeCount: number; volume: string | null;
  minPrice: string | null; maxPrice: string | null };
type CloseWitness = { end: number; close: string };

const equal = (left: string, right: string): boolean => new Decimal(left).eq(right);

/** Canonical high/low include carried open; raw extrema alone are not the candle extrema. */
export function rawAggregationMatches(candle: AuditCandle, raw: RawMinuteSummary): boolean {
  if (raw.tradeCount === 0) return candle.tradeCount === 0 && equal(candle.volume, '0') &&
    equal(candle.open, candle.high) && equal(candle.open, candle.low) &&
    equal(candle.open, candle.close);
  if (raw.volume === null || raw.minPrice === null || raw.maxPrice === null) return false;
  return candle.tradeCount === raw.tradeCount && equal(candle.volume, raw.volume) &&
    equal(candle.high, Decimal.max(candle.open, raw.maxPrice).toString()) &&
    equal(candle.low, Decimal.min(candle.open, raw.minPrice).toString());
}

export function officialOhlcvMatches(candle: AuditCandle, official: AuditCandle): boolean {
  return candle.end === official.end &&
    (['open', 'high', 'low', 'close', 'volume'] as const)
      .every((field) => equal(candle[field], official[field]));
}

/** At the first complete minute of a new epoch, the predecessor can be the
 * official public kline seed rather than a persisted candle across an OPEN gap. */
export function verifyOpenChain(candles: AuditCandle[], precedingDb: CloseWitness | null,
  boundaryStart: number | null, officialSeed: CloseWitness | null): {
    pass: boolean; reason: string; seedSource: 'DB' | 'OFFICIAL' | 'NONE' } {
  const first = candles[0];
  if (!first || candles.some((candle, index) => !Number.isSafeInteger(candle.end) ||
      (index > 0 && candle.end !== candles[index - 1]!.end + MINUTE))) {
    return { pass: false, reason: 'Missing or nonconsecutive audit candles', seedSource: 'NONE' };
  }
  const predecessorEnd = first.end - MINUTE;
  if (precedingDb && precedingDb.end !== predecessorEnd) {
    return { pass: false, reason: 'Preceding DB candle is not adjacent', seedSource: 'NONE' };
  }
  let seed: CloseWitness | null = precedingDb;
  let source: 'DB' | 'OFFICIAL' | 'NONE' = precedingDb ? 'DB' : 'NONE';
  if (!seed && boundaryStart === predecessorEnd && officialSeed?.end === predecessorEnd) {
    seed = officialSeed;
    source = 'OFFICIAL';
  }
  if (!seed) {
    return { pass: false, reason: 'No verified adjacent DB or first-epoch official seed',
      seedSource: 'NONE' };
  }
  if (officialSeed?.end === predecessorEnd && !equal(seed.close, officialSeed.close)) {
    return { pass: false, reason: 'DB predecessor conflicts with official seed', seedSource: source };
  }
  for (let index = 0; index < candles.length; index++) {
    const expected = index === 0 ? seed.close : candles[index - 1]!.close;
    if (!equal(candles[index]!.open, expected)) {
      return { pass: false, reason: `Open/previous close mismatch at ${candles[index]!.end}`,
        seedSource: source };
    }
  }
  return { pass: true, reason: 'Verified adjacent close chain', seedSource: source };
}
