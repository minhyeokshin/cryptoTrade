import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BybitPublicWs } from '../src/market/bybit-ws.js';
import type { MarketRepository } from '../src/db/repositories/market.js';
import { MarketRuntime } from '../src/market/market-runtime.js';
import { verifyCurrentOverlap } from '../src/market/current-overlap.js';
import { reconcileRecent } from '../src/market/reconcile.js';
import { approvedStartupMode, validateNewEpochApproval } from '../src/market/new-live-epoch-approval.js';
import type { CanonicalTrade } from '../src/types/domain.js';

const gap = Date.parse('2026-10-08T05:55:50.099Z');
const now = Date.parse('2026-10-08T06:43:27Z');
const trade = (id: string, timestamp = now, sequence = 10): CanonicalTrade => ({
  id, timestamp, sequence, receivedAt: timestamp, price: '100000', size: '1',
  side: 'Buy', source: 'WEBSOCKET',
});
const approval = { policy: 'NODE_CURRENT_LIVE_EPOCH',
  approval_id: 'b81884fd-f73c-4477-9940-b92b34dd197e',
  previous_approval_id: '90c276e6-f9d6-457b-a659-d8e3d254116a',
  approved_by_human: true, approved_at: '2026-10-08T08:00:00Z',
  expected_gap_start: '2026-10-08T05:55:50.099Z',
  historical_gap_may_remain_open: true, new_live_epoch_authorized: true,
  forward_shadow_may_start_after_new_epoch_health_pass: false,
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
  it('keeps the distinct V3 template inert until separate human approval', () => {
    const template = JSON.parse(readFileSync('reports/runtime/node_new_live_epoch_approval_v3.pending.json',
      'utf8')) as Record<string, unknown>;
    expect(template.approval_id).not.toBe('b6514764-b05a-4c9d-a845-9bc458aa9f96');
    expect(template.previous_approval_id).toBe('b6514764-b05a-4c9d-a845-9bc458aa9f96');
    expect(template.expected_gap_start).toBe('2026-10-08T08:32:59.332Z');
    expect(template.approved_by_human).toBe(false);
    expect(template.new_live_epoch_authorized).toBe(false);
    expect(template.forward_shadow_may_start_after_new_epoch_health_pass).toBe(false);
    expect(template.actual_orders_allowed).toBe(false);
    expect(template.private_api_allowed).toBe(false);
    expect(() => validateNewEpochApproval(template)).toThrow('approval invalid');
  });
  it('keeps V4 pending, distinct from used V3 and pinned to the verified old DB tail', () => {
    const template = JSON.parse(readFileSync('reports/runtime/node_new_live_epoch_approval_v4.pending.json',
      'utf8')) as Record<string, unknown>;
    expect(template.approval_id).not.toBe('0f9b2760-fa13-47a0-bf7d-3a8c67902bf7');
    expect(template.previous_approval_id).toBe('0f9b2760-fa13-47a0-bf7d-3a8c67902bf7');
    expect(template.expected_gap_start).toBe('2026-10-08T08:32:59.332Z');
    expect(template.expected_last_trade_id).toBe('8fb3b0a4-71c2-50f5-8c27-fabc499b9b2f');
    expect(template.expected_last_candle_end).toBe('2026-10-08T08:33:00.000Z');
    expect(template.required_runtime_commit).toBe('a5e0fdeed56ffa2ffbd4b9eeef9f4ec092ec7c1f');
    expect(template.approved_by_human).toBe(false);
    expect(template.new_live_epoch_authorized).toBe(false);
    expect(template.forward_shadow_may_start_after_new_epoch_health_pass).toBe(false);
    expect(template.actual_orders_allowed).toBe(false);
    expect(template.private_api_allowed).toBe(false);
    expect(() => validateNewEpochApproval(template)).toThrow('approval invalid');
    expect(approvedStartupMode(true)).toBe('WRITE');
  });
  it('accepts human-approved V2 for Producer even while Shadow remains unauthorized', () => {
    expect(validateNewEpochApproval(approval)).toMatchObject({
      new_live_epoch_authorized: true,
      forward_shadow_may_start_after_new_epoch_health_pass: false,
    });
    expect(validateNewEpochApproval({ ...approval,
      forward_shadow_may_start_after_new_epoch_health_pass: true }).approval_id)
      .toBe(approval.approval_id);
  });
  it('preserves OPEN gap and rejects implicit or unsafe approval', () => {
    expect(validateNewEpochApproval(approval)).toEqual(approval);
    expect(() => validateNewEpochApproval({ ...approval, new_live_epoch_authorized: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, historical_gap_may_remain_open: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, actual_orders_allowed: true })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, private_api_allowed: true })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, approved_by_human: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, previous_approval_id: approval.approval_id })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, approved_at: 'PENDING' })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, approved_by_human: false,
      new_live_epoch_authorized: false })).toThrow();
    expect(() => validateNewEpochApproval({ ...approval, previous_approval_id: undefined }))
      .toThrow();
    expect(() => validateNewEpochApproval({ ...approval,
      forward_shadow_may_start_after_new_epoch_health_pass: undefined })).toThrow();
    expect(() => new MarketRuntime('NEW_LIVE_EPOCH', {} as MarketRepository)).toThrow('approval');
    expect(approvedStartupMode(false)).toBe('NEW_LIVE_EPOCH');
    expect(approvedStartupMode(true)).toBe('WRITE');
  });
  it('fails closed before a new boundary if the expected DB tail changed', async () => {
    const ws = new FakeWs();
    const record = vi.fn();
    const persist = vi.fn();
    const repo = { historicalGapStart: async () => gap + 1, persist,
      recordFailure: async () => {} } as unknown as MarketRepository;
    const runtime = new MarketRuntime('NEW_LIVE_EPOCH', repo, ws as unknown as BybitPublicWs,
      { recentTrades: async () => [trade('ws-before-boundary')],
        officialOneMinute: async (end) => ({ end, open: '1', high: '1', low: '1',
          close: '1', volume: '0', tradeCount: 0,
          firstTradeTimestamp: null, lastTradeTimestamp: null }) }, undefined,
      { expectedGapStart: gap, record });
    await expect(runtime.start()).rejects.toThrow('Historical gap start changed');
    expect(record).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  it('never converts a used approval ID into a second new live epoch', () => {
    expect(approvedStartupMode(true)).toBe('WRITE');
    expect(approvedStartupMode(true)).not.toBe('NEW_LIVE_EPOCH');
  });
  it('does not confuse the previous OPEN gap with a newly approved gap', () => {
    expect(validateNewEpochApproval(approval).expected_gap_start).toBe('2026-10-08T05:55:50.099Z');
    const next = { ...approval, approval_id: 'c647773b-20ca-402c-9d3a-c735d4027bf3',
      previous_approval_id: approval.approval_id,
      expected_gap_start: '2026-10-08T07:02:54.737Z' };
    expect(validateNewEpochApproval(next).approval_id).not.toBe(approval.approval_id);
    expect(Date.parse(next.expected_gap_start)).toBeGreaterThan(Date.parse(approval.expected_gap_start));
    expect(() => validateNewEpochApproval({ ...next, approval_id: approval.approval_id })).toThrow();
    // The failed old-epoch restart must remain a failure. A distinct human approval is
    // required to create a future-only epoch; the old REST anchor is not inferred away.
    expect(approvedStartupMode(true)).toBe('WRITE');
    expect(approvedStartupMode(false)).toBe('NEW_LIVE_EPOCH');
  });
  it('requires exact current REST/WS identity and source ordering', () => {
    expect(verifyCurrentOverlap([trade('a')], [trade('a')]).overlap).toBe(1);
    expect(() => verifyCurrentOverlap([trade('a')], [trade('a', now + 1)])).toThrow('mismatch');
    expect(() => verifyCurrentOverlap([{ ...trade('a'), price: '100001' }], [trade('a')])).toThrow('mismatch');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('b')])).toThrow('overlap absent');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('a'), trade('a')])).toThrow('Duplicate WS');
    expect(() => verifyCurrentOverlap([trade('a')], [trade('b', now + 1), trade('a')])).toThrow('ordering');
  });
  it('keeps old-anchor restart blocked while a separately approved current overlap is valid', () => {
    const oldAnchor = trade('old-anchor', gap, 1);
    const current = trade('current', now, 2);
    expect(() => reconcileRecent(oldAnchor, [current], [current])).toThrow('anchor absent');
    expect(verifyCurrentOverlap([current], [current])).toMatchObject({ overlap: 1,
      firstVerified: current });
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
