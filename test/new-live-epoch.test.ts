import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BybitPublicWs } from '../src/market/bybit-ws.js';
import type { MarketRepository } from '../src/db/repositories/market.js';
import { MarketRuntime } from '../src/market/market-runtime.js';
import { verifyCurrentOverlap } from '../src/market/current-overlap.js';
import { approvedStartupMode, validateNewEpochApproval } from '../src/market/new-live-epoch-approval.js';
import type { CanonicalTrade } from '../src/types/domain.js';

const gap = Date.parse('2026-10-08T05:55:50.099Z');
const now = Date.parse('2026-10-08T06:43:27Z');
const trade = (id: string, timestamp = now, sequence = 10): CanonicalTrade => ({
  id, timestamp, sequence, receivedAt: timestamp, price: '100000', size: '1',
  side: 'Buy', source: 'WEBSOCKET',
});
const approval = { policy: 'NODE_CURRENT_LIVE_EPOCH',
  approval_id: '90c276e6-f9d6-457b-a659-d8e3d254116a',
  expected_gap_start: '2026-10-08T05:55:50.099Z',
  historical_gap_may_remain_open: true, new_live_epoch_authorized: true,
  forward_shadow_may_start_after_new_epoch_health_pass: true,
  actual_orders_allowed: false, private_api_allowed: false };

class FakeWs extends EventEmitter {
  connected = false;
  subscribed = false;
  latestTrade: number | null = null;
  lastHeartbeat: number | null = null;
  reconnectCount = 0;
  start(): void {
    this.connected = true; this.subscribed = true;
    this.emit('connected'); this.emit('subscribed');
    this.latestTrade = now;
    this.emit('trade', trade('ws-before-boundary'));
  }
  stop(): void { this.connected = false; this.subscribed = false; }
  add(t: CanonicalTrade): void { this.latestTrade = t.timestamp; this.emit('trade', t); }
}

describe('explicit current live epoch', () => {
  it('preserves OPEN gap and rejects implicit or unsafe approval', () => {
    expect(validateNewEpochApproval(approval)).toEqual(approval);
    expect(() => validateNewEpochApproval({ ...approval, new_live_epoch_authorized: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, historical_gap_may_remain_open: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, actual_orders_allowed: true })).toThrow();
    expect(() => new MarketRuntime('NEW_LIVE_EPOCH', {} as MarketRepository)).toThrow('approval');
    expect(approvedStartupMode(false)).toBe('NEW_LIVE_EPOCH');
    expect(approvedStartupMode(true)).toBe('WRITE');
  });
  it('requires exact current REST/WS identity and source ordering', () => {
    expect(verifyCurrentOverlap([trade('a')], [trade('a')]).overlap).toBe(1);
    expect(() => verifyCurrentOverlap([trade('a')], [trade('a', now + 1)])).toThrow('mismatch');
    expect(() => verifyCurrentOverlap([{ ...trade('a'), price: '100001' }], [trade('a')])).toThrow('mismatch');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('b')])).toThrow('overlap absent');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('a'), trade('a')])).toThrow('Duplicate WS');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('b', now + 1), trade('a')])).toThrow('ordering');
  });
  it('does not use the old anchor, discards the partial minute, and persists a complete one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const ws = new FakeWs();
      const persisted: Array<{ end: number; ids: string[] }> = [];
      let recorded: { gapStart: number; firstId: string; minuteStart: number } | null = null;
      const repo = { historicalGapStart: async () => gap,
        recoveryTail: async () => { throw new Error('old anchor must not be read'); },
        persist: async (candle: { end: number }, rows: CanonicalTrade[]) => {
          persisted.push({ end: candle.end, ids: rows.map((row) => row.id) });
        }, recordFailure: async () => {} } as unknown as MarketRepository;
      const runtime = new MarketRuntime('NEW_LIVE_EPOCH', repo, ws as unknown as BybitPublicWs,
        { recentTrades: async () => [trade('ws-before-boundary')],
          officialOneMinute: async (end) => ({ end, open: '100000', high: '100000',
            low: '100000', close: '100000', volume: end > Date.parse('2026-10-08T06:44:00Z') ? '1' : '0', tradeCount: 0,
            firstTradeTimestamp: null, lastTradeTimestamp: null }) }, () => {},
        { expectedGapStart: gap, record: async (gapStart, first, minuteStart) => {
          recorded = { gapStart, firstId: first.id, minuteStart };
        } });
      const starting = runtime.start();
      await vi.advanceTimersByTimeAsync(36_000);
      await starting;
      expect(recorded).toEqual({ gapStart: gap, firstId: 'ws-before-boundary',
        minuteStart: Date.parse('2026-10-08T06:44:00Z') });
      expect(runtime.status()).toMatchObject({ historicalSourceGap: 'OPEN', continuity: true });
      ws.add(trade('first-complete-minute', Date.parse('2026-10-08T06:44:05Z')));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(persisted[0]).toEqual({ end: Date.parse('2026-10-08T06:45:00Z'),
        ids: ['first-complete-minute'] });
      runtime.stop();
    } finally { vi.useRealTimers(); }
  });
});
