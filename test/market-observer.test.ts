import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { ShadowMarketObserver, sourceSnapshotFresh } from '../src/shadow/market-observer.js';
import type { CanonicalCandle } from '../src/types/domain.js';

const decision = 780_000_000;
const epoch = '00000000-0000-4000-8000-000000000002';
const producer = (at: number) => ({ producerEpochId: epoch, boundaryEpochId: epoch,
  firstCompleteMinuteStartMs: decision - 12_000 * 60_000,
  heartbeatAt: at, heartbeatState: 'RUNNING', leaseHeld: true });
const candle = (end: number): CanonicalCandle => ({ end, open: '100', high: '100', low: '100',
  close: '100', volume: '1', tradeCount: 1, firstTradeTimestamp: end - 1,
  lastTradeTimestamp: end - 1 });
const warmup = Array.from({ length: 11_999 }, (_, i) => candle(decision - (11_999 - i) * 60_000));

describe('dedicated-role canonical market observer', () => {
  it('rejects a diagnostic/old health event or stale canonical candle', () => {
    const healthy = { latestTrade: decision, latestCandle: decision - 60_000,
      latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: decision - 100_000,
      ...producer(decision) };
    expect(sourceSnapshotFresh(healthy, decision + 1000, epoch)).toBe(true);
    expect(sourceSnapshotFresh({ ...healthy, health: 'GAP_RECOVERY' }, decision + 1000, epoch)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, latestCandleStatus: 'HISTORICAL_RECOVERY' }, decision + 1000, epoch)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, latestTrade: decision - 300_000 }, decision + 1000, epoch)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, leaseHeld: false }, decision + 1000, epoch)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, heartbeatAt: decision - 5000 }, decision + 1000, epoch)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, producerEpochId: 'other' }, decision + 1000, epoch)).toBe(false);
  });

  it('starts from current warmup without replay and processes only a fresh new candle', async () => {
    let clock = decision - 1000;
    let latest = decision - 60_000;
    let predictions = 0;
    let transitions = 0;
    const activationAt = decision - 2000;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    const market = {
      sourceState: async () => ({ latestTrade: clock - 100, latestCandle: latest,
        latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: decision - 5000,
        ...producer(clock - 100) }),
      warmupBefore: async () => warmup,
      finalizedAfter: async (cursor: number) => latest === decision && cursor < decision ? [candle(decision)] : [],
    };
    const observer = new ShadowMarketObserver(market,
      { predict: async (_candles, timestamp) => { predictions++;
        return { decisionTimestamp: timestamp, featureCutoff: timestamp, side: 'NO_ACTION' as const,
          confidence: 0, actionable: false, flipActionable: false,
          modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash }; } },
      { snapshot: () => state, process: async () => { transitions++;
        return { status: 'NO_ACTION', entry: false, exit: false }; } },
      activationAt, epoch, () => true, () => clock);
    await observer.start();
    expect(predictions).toBe(0);
    expect(observer.status().cursor).toBe(decision - 60_000);
    clock = decision + 1000;
    latest = decision;
    expect(await observer.pollOnce()).toEqual(['NO_ACTION_RECORDED']);
    expect(predictions).toBe(1);
    expect(transitions).toBe(1);
    expect(await observer.pollOnce()).toEqual([]);
  });

  it('fails closed on a delayed candle rather than backfilling a Shadow signal', async () => {
    let clock = decision - 1000;
    let latest = decision - 60_000;
    const activationAt = decision - 2000;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    const market = {
      sourceState: async () => ({ latestTrade: clock - 100, latestCandle: latest,
        latestCandleStatus: 'HEALTHY', health: 'HEALTHY', healthAt: decision - 5000,
        ...producer(clock - 100) }),
      warmupBefore: async () => warmup,
      finalizedAfter: async () => [candle(decision)],
    };
    const observer = new ShadowMarketObserver(market,
      { predict: async () => { throw new Error('must not infer late candle'); } },
      { snapshot: () => state, process: async () => { throw new Error('must not trade'); } },
      activationAt, epoch, () => true, () => clock);
    await observer.start();
    latest = decision;
    clock = decision + 60_001;
    await expect(observer.pollOnce()).rejects.toThrow('Delayed or duplicate causal candle');
    expect(observer.status().faulted).toBe(true);
  });

  it('allows a causal entry only while the producer lease and approved epoch remain live', async () => {
    let clock = decision - 1000;
    let latest = decision - 60_000;
    let leaseHeld = true;
    let entries = 0;
    const activationAt = decision - 2000;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    const market = {
      sourceState: async () => ({ latestTrade: clock - 100, latestCandle: latest,
        latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: clock - 100,
        ...producer(clock - 100), leaseHeld }),
      warmupBefore: async () => warmup,
      finalizedAfter: async () => [candle(decision)],
    };
    const makeObserver = () => new ShadowMarketObserver(market,
      { predict: async (_candles, timestamp) => ({ decisionTimestamp: timestamp,
        featureCutoff: timestamp, side: 'LONG' as const, confidence: 0.6,
        actionable: true, flipActionable: true,
        modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash }) },
      { snapshot: () => state, process: async () => { entries++;
        return { status: 'ENTRY', entry: true, exit: false }; } },
      activationAt, epoch, () => true, () => clock);
    const observer = makeObserver();
    await observer.start();
    latest = decision;
    clock = decision + 1000;
    expect(await observer.pollOnce()).toEqual(['ENTRY_DECISION']);
    clock = decision + 2000;
    const trade = { id: 'new', timestamp: clock, receivedAt: clock, side: 'Buy' as const,
      price: '100', size: '1', sequence: 1, source: 'WEBSOCKET' as const };
    expect(await observer.onPublicTrade(trade)).toMatchObject({ entry: true });
    expect(entries).toBe(1);

    clock = decision - 1000;
    latest = decision - 60_000;
    const blocked = makeObserver();
    await blocked.start();
    clock = decision + 1000;
    latest = decision;
    expect(await blocked.pollOnce()).toEqual(['ENTRY_DECISION']);
    clock = decision + 2000;
    leaseHeld = false;
    await expect(blocked.onPublicTrade(trade)).rejects.toThrow('Producer lease/epoch lost');
    expect(entries).toBe(1);
    expect(blocked.status().faulted).toBe(true);
  });

  it('faults on a missing finalized minute without computing a retroactive result', async () => {
    let clock = decision - 1000;
    let latest = decision - 60_000;
    const state = new ShadowEngine(decision - 2000, 100, 1).state;
    const observer = new ShadowMarketObserver({
      sourceState: async () => ({ latestTrade: clock - 100, latestCandle: latest,
        latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: clock - 100,
        ...producer(clock - 100) }),
      warmupBefore: async () => warmup,
      finalizedAfter: async () => [candle(decision + 60_000)],
    }, { predict: async () => { throw new Error('gap must not infer'); } },
    { snapshot: () => state, process: async () => { throw new Error('gap must not settle'); } },
    decision - 2000, epoch, () => true, () => clock);
    await observer.start();
    clock = decision + 61_000;
    latest = decision + 60_000;
    await expect(observer.pollOnce()).rejects.toThrow('Missing/duplicate finalized candle');
    expect(observer.status().faulted).toBe(true);
  });
});
