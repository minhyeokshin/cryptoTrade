import { describe, expect, it } from 'vitest';
import type { CanonicalTrade } from '../src/types/domain.js';
import { reconcileRecent } from '../src/market/reconcile.js';

const trade = (id: string, timestamp: number, sequence: number): CanonicalTrade => ({
  id, timestamp, sequence, receivedAt: timestamp + 10, side: 'Buy',
  price: '100', size: '1', source: 'WEBSOCKET',
});

describe('bounded public REST/WS reconnect reconciliation', () => {
  const anchor = trade('anchor', 1000, 1);
  const missing = trade('missing', 2000, 2);
  const overlap = trade('overlap', 3000, 3);
  it('recovers only absent post-anchor trades with exact identity overlap', () => {
    const result = reconcileRecent(anchor, [overlap, missing, anchor], [overlap]);
    expect(result.recovered.map((x) => x.id)).toEqual(['missing']);
    expect(result.overlap).toBe(1);
  });
  it('rejects an anchor outside the bounded recent window', () => {
    expect(() => reconcileRecent(anchor, [missing, overlap], [overlap])).toThrow('anchor absent');
  });
  it('rejects mismatched overlap even when IDs match', () => {
    expect(() => reconcileRecent(anchor, [anchor, missing, overlap],
      [{ ...overlap, price: '101' }])).toThrow('REST/WS trade mismatch');
  });
  it('rejects ambiguous equal-millisecond/sequence anchor ordering', () => {
    expect(() => reconcileRecent(anchor, [anchor, trade('tie', 1000, 1), overlap], [overlap]))
      .toThrow('Ambiguous');
  });
});
