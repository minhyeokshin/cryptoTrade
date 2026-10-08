import { describe, expect, it } from 'vitest';
import type { CanonicalTrade } from '../src/types/domain.js';
import { reconcileRecent } from '../src/market/reconcile.js';

const trade = (id: string, timestamp: number, sequence: number): CanonicalTrade => ({
  id, timestamp, sequence, receivedAt: timestamp + 10, side: 'Buy',
  price: '100', size: '1', source: 'WEBSOCKET',
});

describe('bounded public REST/WS reconnect reconciliation', () => {
  const anchor = trade('anchor', 1000, 1);
  const before = trade('before', 900, 0);
  const missing = trade('missing', 2000, 2);
  const overlap = trade('overlap', 3000, 3);
  it('recovers only absent post-anchor trades with exact identity overlap', () => {
    const result = reconcileRecent(anchor, [overlap, missing, anchor, before], [overlap]);
    expect(result.recovered.map((x) => x.id)).toEqual(['missing']);
    expect(result.overlap).toBe(1);
  });
  it('rejects an anchor outside the bounded recent window', () => {
    expect(() => reconcileRecent(anchor, [missing, overlap], [overlap])).toThrow('anchor absent');
  });
  it('rejects mismatched overlap even when IDs match', () => {
    expect(() => reconcileRecent(anchor, [before, anchor, missing, overlap],
      [{ ...overlap, price: '101' }])).toThrow('REST/WS trade mismatch');
  });
  it('rejects a WS trade omitted from REST inside the proven interval', () => {
    expect(() => reconcileRecent(anchor, [before, anchor, overlap],
      [trade('ws-only', 2000, 2), overlap])).toThrow('REST/WS missing trade ID');
  });
  it('rejects ambiguous equal-millisecond/sequence anchor ordering', () => {
    expect(() => reconcileRecent(anchor, [before, anchor, trade('tie', 1000, 1), overlap], [overlap]))
      .toThrow('Ambiguous');
  });
  it('accepts a verified multi-trade persisted millisecond bucket without lexical ID sorting', () => {
    const peer = trade('zzz', 1000, 1);
    const later = trade('aaa', 1000, 2);
    const result = reconcileRecent(anchor, [overlap, later, peer, anchor, before],
      [later, overlap], [anchor, peer]);
    expect(result.overlap).toBe(2);
    expect(result.recovered).toEqual([]);
  });
  it('recovers a same-millisecond trade only with a strictly later unique sequence', () => {
    const later = trade('aaa', 1000, 2);
    const result = reconcileRecent(anchor, [overlap, later, anchor, before], [overlap]);
    expect(result.recovered.map((x) => x.id)).toEqual(['aaa']);
  });
  it('fails closed when the persisted anchor bucket is incomplete or conflicts', () => {
    const peer = trade('peer', 1000, 1);
    expect(() => reconcileRecent(anchor, [before, anchor, overlap], [overlap], [anchor, peer]))
      .toThrow('Persisted anchor millisecond group mismatch');
    expect(() => reconcileRecent(anchor, [before, anchor, { ...peer, price: '101' }, overlap],
      [overlap], [anchor, peer])).toThrow('Persisted anchor millisecond group mismatch');
  });
  it('rejects a REST page truncated inside the anchor millisecond bucket', () => {
    expect(() => reconcileRecent(anchor, [anchor, overlap], [overlap]))
      .toThrow('REST window does not cover full anchor');
  });
  it('rejects duplicate REST trade IDs and ambiguous new sequence ties', () => {
    expect(() => reconcileRecent(anchor, [before, anchor, anchor, overlap], [overlap]))
      .toThrow('Duplicate REST trade ID');
    expect(() => reconcileRecent(anchor, [before, anchor, trade('a', 2000, 2),
      trade('b', 2000, 2), overlap], [overlap])).toThrow('Ambiguous post-anchor');
  });
  it('rejects a same-timestamp trade ordered before the persisted anchor', () => {
    expect(() => reconcileRecent(anchor, [before, anchor, trade('older', 1000, 0), overlap],
      [overlap])).toThrow('Ambiguous equal-timestamp');
  });
});
