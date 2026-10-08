import { describe, expect, it } from 'vitest';
import { aggregate, CandleBuilder } from '../src/market/candle-builder.js';
import { officialOhlcvMatches, rawAggregationMatches, verifyOpenChain,
  type AuditCandle } from '../src/market/epoch-candle-audit.js';
import { validateNewEpochApproval } from '../src/market/new-live-epoch-approval.js';
import type { CanonicalTrade } from '../src/types/domain.js';

const trade = (id: string, price: string, size = '2'): CanonicalTrade => ({
  id, timestamp: 30_000, receivedAt: 30_000, sequence: 1,
  price, size, side: 'Buy', source: 'WEBSOCKET',
});
const candle = (end: number, open: string, close: string): AuditCandle => ({
  end, open, high: open, low: close, close, volume: '2', tradeCount: 1,
});

describe('old Node epoch candle audit contract', () => {
  it('A: carries previous close into high even above every raw price', () => {
    const built = aggregate([trade('a', '82772.9')], 60_000, '82786');
    expect(built).toMatchObject({ open: '82786', high: '82786', low: '82772.9',
      volume: '2', tradeCount: 1 });
    expect(rawAggregationMatches(built!, { tradeCount: 1, volume: '2',
      minPrice: '82772.9', maxPrice: '82772.9' })).toBe(true);
  });
  it('B: carries previous close into low even below every raw price', () => {
    const built = aggregate([trade('a', '102')], 60_000, '100');
    expect(built).toMatchObject({ high: '102', low: '100' });
    expect(rawAggregationMatches(built!, { tradeCount: 1, volume: '2',
      minPrice: '102', maxPrice: '102' })).toBe(true);
  });
  it('C: accepts exact DB/official OHLCV only', () => {
    const db = candle(60_000, '100', '99');
    expect(officialOhlcvMatches(db, { ...db })).toBe(true);
    expect(officialOhlcvMatches(db, { ...db, volume: '3' })).toBe(false);
    expect(officialOhlcvMatches(db, { ...db, end: 120_000 })).toBe(false);
  });
  it('D/F: verifies raw volume and count and rejects a missing raw trade', () => {
    const db = { ...candle(60_000, '100', '99'), high: '101', low: '99',
      volume: '5', tradeCount: 2 };
    expect(rawAggregationMatches(db, { tradeCount: 2, volume: '5',
      minPrice: '99', maxPrice: '101' })).toBe(true);
    expect(rawAggregationMatches(db, { tradeCount: 1, volume: '3',
      minPrice: '99', maxPrice: '101' })).toBe(false);
  });
  it('E: an OPEN historical gap permits only a verified first-epoch official seed', () => {
    const first = candle(60_000, '100', '99');
    const next = candle(120_000, '99', '98');
    expect(verifyOpenChain([first, next], null, 0, { end: 0, close: '100' }))
      .toMatchObject({ pass: true, seedSource: 'OFFICIAL' });
    expect(verifyOpenChain([first, next], null, null, { end: 0, close: '100' }).pass)
      .toBe(false);
    expect(verifyOpenChain([first, next], null, 0, null).pass).toBe(false);
    expect(verifyOpenChain([first, { ...next, open: '97' }], null, 0,
      { end: 0, close: '100' }).pass).toBe(false);
  });
  it('F: existing adjacent DB predecessor conflicting with official seed fails', () => {
    const first = candle(60_000, '100', '99');
    expect(verifyOpenChain([first], { end: 0, close: '100' }, null,
      { end: 0, close: '101' }).pass).toBe(false);
  });
  it('requires official zero-volume verification for an empty minute', () => {
    const builder = new CandleBuilder();
    expect(() => builder.finalize(60_000, 60_000, '100')).toThrow('Empty minute');
    const official = { ...candle(60_000, '100', '100'), volume: '0', tradeCount: 0,
      firstTradeTimestamp: null, lastTradeTimestamp: null };
    expect(builder.finalize(60_000, 60_000, '100', official))
      .toMatchObject({ volume: '0', tradeCount: 0 });
    expect(rawAggregationMatches(official, { tradeCount: 0, volume: null,
      minPrice: null, maxPrice: null })).toBe(true);
  });
  it('G: reused or wrong approval ID fails', () => {
    const candidate = { policy: 'NODE_CURRENT_LIVE_EPOCH',
      approval_id: 'b6514764-b05a-4c9d-a845-9bc458aa9f96',
      previous_approval_id: '90c276e6-f9d6-457b-a659-d8e3d254116a',
      approved_by_human: true, approved_at: '2026-10-08T09:00:00Z',
      expected_gap_start: '2026-10-08T07:02:54.737Z',
      historical_gap_may_remain_open: true, new_live_epoch_authorized: true,
      forward_shadow_may_start_after_new_epoch_health_pass: true,
      actual_orders_allowed: false, private_api_allowed: false };
    expect(validateNewEpochApproval(candidate).approval_id).toBe(candidate.approval_id);
    expect(() => validateNewEpochApproval({ ...candidate,
      approval_id: candidate.previous_approval_id })).toThrow();
  });
});
