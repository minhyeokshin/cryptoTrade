import type { CanonicalCandle } from '../types/domain.js';

/** The frozen 120-column feature calculation remains in the Python research code. */
export function assertCausalCandles(candles: CanonicalCandle[], decisionTimestamp: number): void {
  if (decisionTimestamp % 60_000 !== 0) throw new Error('Not a completed UTC 1m boundary');
  if (!candles.length || candles.at(-1)?.end !== decisionTimestamp) throw new Error('Missing completed decision candle');
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];
    if (!current || current.end > decisionTimestamp ||
      (i > 0 && current.end !== candles[i - 1]!.end + 60_000)) {
      throw new Error('Future/missing/noncontiguous candle');
    }
  }
}

export function assertFiveMinuteEntryClock(decisionTimestamp: number): void {
  if (decisionTimestamp % (5 * 60_000) !== 0) throw new Error('Not a UTC 5m entry decision');
}
