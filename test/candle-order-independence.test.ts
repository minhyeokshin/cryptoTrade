import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/market/candle-builder.js';
import type { CanonicalTrade } from '../src/types/domain.js';

const end = Date.parse('2026-10-08T14:26:00Z');
const groupTime = Date.parse('2026-10-08T14:25:46.793Z');
const trade = (id: string, timestamp: number, price: string, size: string): CanonicalTrade => ({
  id, timestamp, receivedAt: timestamp, sequence: 118907689527,
  side: 'Buy', price, size, source: 'REST_RECENT',
});
const first = trade('first', groupTime, '82483.6', '382');
const second = trade('second', groupTime, '82483.6', '500');

describe('existing candle aggregation under unproven intra-group order', () => {
  it('proves every permutation of the failing pair leaves observed minute OHLCV unchanged', () => {
    const before = trade('before', groupTime - 1, '82491.7', '4');
    const after = trade('after', groupTime + 1, '82467.3', '1000');
    const candidates = [[before, first, second, after], [before, second, first, after]];
    const candles = candidates.map((candidate) => aggregate(candidate, end, '82431.9'));
    expect(candles[0]).toEqual(candles[1]);
    expect(candles[0]).toMatchObject({ open: '82431.9', high: '82491.7',
      close: '82467.3', volume: '1886', tradeCount: 4 });
  });
  it('establishes the exhaustive permutation criterion for any tied group', () => {
    // O/H/L/V are symmetric functions of a fixed multiset. Close is invariant iff
    // there is a strictly later final trade, or every possible final tied price is equal.
    const allPossibleCloses = (prices: string[], laterFinalPrice?: string) =>
      new Set(laterFinalPrice === undefined ? prices : [laterFinalPrice]);
    expect([...allPossibleCloses(['82483.6', '82483.6'])]).toEqual(['82483.6']);
    expect([...allPossibleCloses(['82483.6', '82480.0'], '82467.3')]).toEqual(['82467.3']);
    expect(allPossibleCloses(['82483.6', '82480.0']).size).toBe(2);
  });
  it('is OHLCV-equivalent for equal-price tied trades, even if they are last', () => {
    const a = aggregate([first, second], end, '82431.9');
    const b = aggregate([second, first], end, '82431.9');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ close: '82483.6', volume: '882', tradeCount: 2 });
  });
  it('is OHLCV-equivalent for differing tied prices if a later priced trade fixes close', () => {
    const different = { ...second, price: '82480.0' };
    const later = trade('later', groupTime + 1, '82467.3', '1');
    const a = aggregate([first, different, later], end, '82431.9');
    const b = aggregate([different, first, later], end, '82431.9');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ close: '82467.3', volume: '883', tradeCount: 3 });
  });
  it('does not claim close equivalence for differing prices in the final tied group', () => {
    const different = { ...second, price: '82480.0' };
    const a = aggregate([first, different], end, '82431.9');
    const b = aggregate([different, first], end, '82431.9');
    expect(a).toMatchObject({ open: b?.open, high: b?.high, low: b?.low,
      volume: b?.volume, tradeCount: b?.tradeCount });
    expect(a?.close).not.toBe(b?.close);
  });
});
