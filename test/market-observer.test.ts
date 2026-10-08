import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { ShadowMarketObserver, sourceSnapshotFresh } from '../src/shadow/market-observer.js';
import type { CanonicalCandle } from '../src/types/domain.js';

const decision = 720_000_000;
const candle = (end: number): CanonicalCandle => ({ end, open: '100', high: '100', low: '100',
  close: '100', volume: '1', tradeCount: 1, firstTradeTimestamp: end - 1,
  lastTradeTimestamp: end - 1 });
const warmup = Array.from({ length: 11_999 }, (_, i) => candle(decision - (11_999 - i) * 60_000));

describe('dedicated-role canonical market observer', () => {
  it('rejects a diagnostic/old health event or stale canonical candle', () => {
    const healthy = { latestTrade: decision, latestCandle: decision - 60_000,
      latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: decision - 100_000 };
    expect(sourceSnapshotFresh(healthy, decision + 1000)).toBe(true);
    expect(sourceSnapshotFresh({ ...healthy, health: 'GAP_RECOVERY' }, decision + 1000)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, latestCandleStatus: 'HISTORICAL_RECOVERY' }, decision + 1000)).toBe(false);
    expect(sourceSnapshotFresh({ ...healthy, latestTrade: decision - 300_000 }, decision + 1000)).toBe(false);
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
        latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: decision - 5000 }),
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
      activationAt, () => true, () => clock);
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
        latestCandleStatus: 'HEALTHY', health: 'HEALTHY', healthAt: decision - 5000 }),
      warmupBefore: async () => warmup,
      finalizedAfter: async () => [candle(decision)],
    };
    const observer = new ShadowMarketObserver(market,
      { predict: async () => { throw new Error('must not infer late candle'); } },
      { snapshot: () => state, process: async () => { throw new Error('must not trade'); } },
      activationAt, () => true, () => clock);
    await observer.start();
    latest = decision;
    clock = decision + 60_001;
    await expect(observer.pollOnce()).rejects.toThrow('Delayed or duplicate causal candle');
    expect(observer.status().faulted).toBe(true);
  });
});
