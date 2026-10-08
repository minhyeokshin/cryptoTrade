import type { CanonicalCandle } from '../types/domain.js';

/** Frozen feature warmup must be built exclusively from the verified new live epoch. */
export function assertPostEpochWarmup(candles: CanonicalCandle[], firstCompleteMinuteStart: number,
  required: number): void {
  if (!Number.isSafeInteger(firstCompleteMinuteStart) || firstCompleteMinuteStart <= 0 ||
      !Number.isSafeInteger(required) || required < 1 || candles.length !== required ||
      candles[0]!.end <= firstCompleteMinuteStart ||
      candles.some((candle, i) => i > 0 && candle.end !== candles[i - 1]!.end + 60_000)) {
    throw new Error('Full contiguous post-epoch frozen warmup unavailable');
  }
}
