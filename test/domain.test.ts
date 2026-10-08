import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { normalizeWsTrade } from '../src/market/trade-normalizer.js';
import { aggregate, CandleBuilder, endLabel } from '../src/market/candle-builder.js';
import { sourceFresh } from '../src/market/freshness.js';
import { executionPrice, grossBtc, inverseContracts, settle } from '../src/shadow/inverse-pnl.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { DrawdownTracker } from '../src/shadow/drawdown.js';
import { tradeMetrics } from '../src/shadow/metrics.js';
import { formatHourlyReport } from '../src/report/hourly-report.js';
import { HourlyScheduler } from '../src/report/hourly-scheduler.js';
import { validateRestoredState } from '../src/shadow/state-store.js';
import { assertCausalCandles, assertFiveMinuteEntryClock } from '../src/inference/feature-builder.js';
import type { CanonicalCandle, FrozenPrediction } from '../src/types/domain.js';

const raw = (time: string, id: string, price = '100') =>
  ({ T: time, i: id, s: 'BTCUSD', S: 'Buy', p: price, v: '2', seq: 1 });
const prediction = (decisionTimestamp: number, side: FrozenPrediction['side'], confidence = .6): FrozenPrediction => ({
  decisionTimestamp, featureCutoff: decisionTimestamp, side, confidence,
  actionable: side !== 'NO_ACTION' && decisionTimestamp % 300_000 === 0,
  flipActionable: side !== 'NO_ACTION', modelHash: FROZEN.directionModelHash,
  featureSchemaHash: FROZEN.featureSchemaHash,
});

describe('Python canonical market contract', () => {
  it('truncates raw timestamp to millisecond and validates payload', () => {
    const trade = normalizeWsTrade(raw('1791421538552.8', 'a'));
    expect(trade.timestamp).toBe(1791421538552);
    expect(() => normalizeWsTrade({ ...raw('1', 'a'), S: 'Other' })).toThrow();
  });
  it('assigns exact minute boundary to next candle', () => {
    expect(endLabel(59_999)).toBe(60_000);
    expect(endLabel(60_000)).toBe(120_000);
  });
  it('uses previous close as open, preserves Decimal volume, ignores next-boundary trade', () => {
    const trades = [normalizeWsTrade(raw('59999', 'a', '102')),
      normalizeWsTrade(raw('60000', 'b', '103'))];
    const c = aggregate(trades, 60_000, '100');
    expect(c).toMatchObject({ open: '100', high: '102', low: '100', close: '102', volume: '2', tradeCount: 1 });
  });
  it('rejects duplicates, conflicting IDs, and unfinished candles', () => {
    const b = new CandleBuilder(); const t = normalizeWsTrade(raw('59999', 'a'));
    expect(b.ingest(t)).toBe('ACCEPTED'); expect(b.ingest(t)).toBe('DUPLICATE');
    expect(() => b.ingest(normalizeWsTrade(raw('59999', 'a', '101')))).toThrow();
    expect(() => b.finalize(60_000, 59_999, '100')).toThrow();
    expect(b.finalize(60_000, 60_000, '100').tradeCount).toBe(1);
    expect(() => b.finalize(60_000, 60_001, '100')).toThrow();
  });
  it('detects out-of-order arrivals and official mismatch', () => {
    const b = new CandleBuilder(); b.ingest(normalizeWsTrade(raw('59999', 'a')));
    b.ingest(normalizeWsTrade(raw('59998', 'b')));
    expect(b.orderingViolations).toBe(1);
    const official: CanonicalCandle = { end: 60_000, open: '100', high: '999', low: '100', close: '100',
      volume: '4', tradeCount: 0, firstTradeTimestamp: null, lastTradeTimestamp: null };
    expect(() => b.finalize(60_000, 60_000, '100', official)).toThrow('mismatch');
  });
  it('blocks stale source and future candle leakage', () => {
    expect(sourceFresh(200_000, 190_000, 180_000, true, true)).toBe(true);
    expect(sourceFresh(400_000, 190_000, 180_000, true, true)).toBe(false);
    const c = (end: number): CanonicalCandle => ({ end, open: '1', high: '1', low: '1', close: '1',
      volume: '1', tradeCount: 1, firstTradeTimestamp: end - 1, lastTradeTimestamp: end - 1 });
    assertCausalCandles([c(240_000), c(300_000)], 300_000);
    assertCausalCandles([c(300_000), c(360_000)], 360_000);
    expect(() => assertFiveMinuteEntryClock(360_000)).toThrow();
    assertFiveMinuteEntryClock(300_000);
    expect(() => assertCausalCandles([c(300_000), c(360_000)], 300_000)).toThrow();
  });
});

describe('frozen inverse Shadow mechanics', () => {
  it('uses inverse long/short PnL and adverse slippage on both legs', () => {
    expect(grossBtc(36, 100, 110, 'LONG')).toBeCloseTo(36 * (1 / 100 - 1 / 110));
    expect(grossBtc(36, 100, 90, 'SHORT')).toBeCloseTo(-36 * (1 / 100 - 1 / 90));
    expect(executionPrice(100, 'LONG', true)).toBeCloseTo(100.02);
    expect(executionPrice(110, 'LONG', false)).toBeCloseTo(109.978);
    const s = settle(36, 100, 110, 'LONG');
    expect(s.netBtc).toBeCloseTo(s.grossBtc - s.slippageBtc - s.entryFeeBtc - s.exitFeeBtc);
    // Fixed Python inverse_pnl.settle parity sample, not strategy fitting.
    expect(s.grossBtc).toBeCloseTo(0.03272727272727275, 13);
    expect(s.slippageBtc).toBeCloseTo(0.00013745324186172775, 13);
    expect(s.netBtc).toBeCloseTo(0.03221182307029117, 13);
    expect(settle(36, 100, 90, 'SHORT').netBtc).toBeCloseTo(0.03943000597720021, 13);
  });
  it('allocates 20% of current equity at fixed 1.8x, rounded to inverse lot', () => {
    expect(inverseContracts(100, 1)).toEqual({ margin: 20, notional: 36, contracts: 36 });
    expect(inverseContracts(110, 1).contracts).toBe(39);
  });
  it('opens one position, ignores duplicate, exits on opposite actionable flip', () => {
    const e = new ShadowEngine(0, 100, 1);
    const first = e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    expect(first.entry?.contracts).toBe(36);
    expect(e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true).status).toBe('DUPLICATE');
    const second = e.consume(prediction(360_000, 'SHORT'), 360_001, 110, 110, true);
    expect(second.exit?.exitReason).toBe('DIRECTION_FLIP');
    expect(second.entry).toBeNull();
    expect(e.state.closed).toHaveLength(1);
  });
  it('uses the completed monitor minute, not delivery latency, to classify a flip', () => {
    const e = new ShadowEngine(0, 100, 1);
    e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    const result = e.consume(prediction(540_000, 'SHORT'), 600_000, 110, 110, true);
    expect(result.exit?.exitReason).toBe('DIRECTION_FLIP');
  });
  it('uses five-minute horizon and disallows pre-activation signals', () => {
    const e = new ShadowEngine(1, 100, 1);
    expect(e.consume(prediction(0, 'LONG'), 2, 100, 100, true).status).toBe('PRE_ACTIVATION');
    e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    const result = e.consume(prediction(600_000, 'NO_ACTION', 0), 600_001, 100, 100, true);
    expect(result.exit?.exitReason).toBe('HORIZON');
  });
  it('rejects inconsistent frozen actionable flags', () => {
    const e = new ShadowEngine(0, 100, 1);
    expect(() => e.consume({ ...prediction(300_000, 'LONG'), actionable: false },
      300_001, 100, 100, true)).toThrow('flags mismatch');
  });
  it('orders horizon exit before same-boundary actionable re-entry without overlap', () => {
    const e = new ShadowEngine(0, 100, 1);
    e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    const result = e.consume(prediction(600_000, 'SHORT'), 600_001, 110, 110, true);
    expect(result.status).toBe('EXIT_AND_ENTRY');
    expect(result.exit?.exitReason).toBe('HORIZON');
    expect(result.entry?.side).toBe('SHORT');
    expect(e.state.closed).toHaveLength(1);
    expect(e.state.open?.signalTimestamp).toBe(600_000);
  });
  it('restores position and processed signal state without re-entry', () => {
    const e = new ShadowEngine(0, 100, 1);
    e.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    const restored = new ShadowEngine(0, 100, 1, structuredClone(e.state));
    expect(restored.state.open?.side).toBe('LONG');
    expect(restored.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true).status).toBe('DUPLICATE');
    expect(validateRestoredState(restored.state, 0).open?.side).toBe('LONG');
    expect(() => validateRestoredState({ ...restored.state, processedSignals: ['x', 'x'] })).toThrow();
  });
  it('computes MDD, PF, expectancy and losing streak', () => {
    const d = new DrawdownTracker(100); d.observe(110); d.observe(88);
    expect(d.mdd).toBeCloseTo(.2);
    const m = tradeMetrics([{ side: 'LONG', netBtc: 2, netUsd: 2, holdingSeconds: 60 },
      { side: 'SHORT', netBtc: -1, netUsd: -1, holdingSeconds: 60 }]);
    expect(m.profitFactor).toBe(2); expect(m.expectancyBtc).toBe(.5);
    expect(m.maxConsecutiveLosses).toBe(1);
  });
  it('formats zero-trade hourly heartbeat and zero-order invariant', () => {
    const text = formatHourlyReport({ reportTimestamp: '2026-10-08T02:00:00Z', startTimestamp: '2026-10-08T01:00:00Z',
      currentEquity: 100, totalTrades: 0, wins: 0, losses: 0, winRate: null, profitFactor: null,
      expectancy: null, netPnl: 0, returnPct: 0, currentDrawdown: 0, mdd: 0,
      maxConsecutiveLosses: 0, openPosition: false, openPositionSide: null, openPositionEntry: null,
      openPositionUnrealizedPnl: null, latestSignal: null, latestConfidence: null,
      sourceLastTradeTimestamp: null, sourceFreshness: false, processUptimeSeconds: 3600 });
    expect(text).toContain('TOTAL_TRADES=0'); expect(text).toContain('ACTUAL_ORDERS=0');
    expect(text).toContain('PRIVATE_API_CALLS=0');
  });
  it('schedules a zero-trade heartbeat only after activation and rounds to UTC hour', async () => {
    const sent: string[] = [];
    const scheduler = new HourlyScheduler({ snapshot: async () => ({
      reportTimestamp: '', startTimestamp: '2026-10-08T01:30:00Z', currentEquity: 100,
      totalTrades: 0, wins: 0, losses: 0, winRate: null, profitFactor: null,
      expectancy: null, netPnl: 0, returnPct: 0, currentDrawdown: 0, mdd: 0,
      maxConsecutiveLosses: 0, openPosition: false, openPositionSide: null,
      openPositionEntry: null, openPositionUnrealizedPnl: null, latestSignal: null,
      latestConfidence: null, sourceLastTradeTimestamp: null, sourceFreshness: false,
      processUptimeSeconds: 1,
    }) }, { send: async (s) => { sent.push(s.reportTimestamp); return 'SENT'; } }, () => {});
    expect(await scheduler.tick(new Date('2026-10-08T01:59:59Z'))).toBe('NOT_STARTED');
    expect(await scheduler.tick(new Date('2026-10-08T02:00:05Z'))).toBe('SENT');
    expect(sent).toEqual(['2026-10-08T02:00:05.000Z']);
  });
});
