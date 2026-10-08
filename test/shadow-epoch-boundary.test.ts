import { describe, expect, it } from 'vitest';
import { assertPostEpochWarmup } from '../src/shadow/epoch-boundary.js';
import type { CanonicalCandle } from '../src/types/domain.js';

const boundary = 180_000;
const candle = (end: number): CanonicalCandle => ({ end, open: '100', high: '100',
  low: '100', close: '100', volume: '0', tradeCount: 0,
  firstTradeTimestamp: null, lastTradeTimestamp: null });

describe('post-current-live-epoch feature firewall', () => {
  it('accepts only a complete causal post-epoch warmup', () => {
    expect(() => assertPostEpochWarmup([candle(240_000), candle(300_000)], boundary, 2))
      .not.toThrow();
  });
  it('rejects retroactive pre-epoch data, missing candles, and missing warmup', () => {
    expect(() => assertPostEpochWarmup([candle(180_000), candle(240_000)], boundary, 2))
      .toThrow('post-epoch');
    expect(() => assertPostEpochWarmup([candle(240_000), candle(360_000)], boundary, 2))
      .toThrow('post-epoch');
    expect(() => assertPostEpochWarmup([candle(240_000)], boundary, 2))
      .toThrow('post-epoch');
  });
});
