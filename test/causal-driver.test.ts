import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import type { CanonicalCandle, CanonicalTrade } from '../src/types/domain.js';
import { CausalShadowDriver } from '../src/shadow/causal-driver.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';

const minute = 60_000;
const decision = 720_000_000;
const candle = (end: number): CanonicalCandle => ({ end, open: '100', high: '100', low: '100',
  close: '100', volume: '1', tradeCount: 1, firstTradeTimestamp: end - 1,
  lastTradeTimestamp: end - 1 });
const trade = (receivedAt: number): CanonicalTrade => ({ id: String(receivedAt), timestamp: receivedAt,
  receivedAt, side: 'Buy', price: '100', size: '1', sequence: 1, source: 'WEBSOCKET' });

describe('causal live Shadow decision driver', () => {
  it('never replays warmup and uses only the first public trade after inference is ready', async () => {
    const activationAt = decision - 1000;
    let clock = decision + 1000;
    let called = 0;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    const driver = new CausalShadowDriver(activationAt, decision - 500,
      { predict: async (rows, end) => {
        expect(rows).toHaveLength(12_000);
        expect(rows.at(-1)?.end).toBe(end);
        return { decisionTimestamp: end, featureCutoff: end, side: 'LONG', confidence: .6,
          actionable: true, flipActionable: true, modelHash: FROZEN.directionModelHash,
          featureSchemaHash: FROZEN.featureSchemaHash };
      } },
      { snapshot: () => state, process: async () => { called++; return { status: 'ENTRY', entry: true, exit: false }; } },
      () => true, () => clock);
    driver.seedWarmup(Array.from({ length: 11_999 }, (_, i) =>
      candle(decision - (11_999 - i) * minute)));
    expect(await driver.onFinalizedCandle(candle(decision))).toBe('ENTRY_DECISION');
    expect(await driver.onPublicTrade(trade(clock), 100)).toBeNull();
    expect(await driver.onPublicTrade({ ...trade(clock + 1), timestamp: clock - 1 }, 100)).toBeNull();
    clock++;
    expect(await driver.onPublicTrade(trade(clock), 100)).toMatchObject({ status: 'ENTRY' });
    expect(called).toBe(1);
    expect(await driver.onPublicTrade(trade(clock + 1), 100)).toBeNull();
  });
  it('fails closed when a finalized minute is missing', async () => {
    const state = new ShadowEngine(decision - 1000, 100, 1).state;
    const driver = new CausalShadowDriver(decision - 1000, decision - 500,
      { predict: async () => { throw new Error('not called'); } },
      { snapshot: () => state, process: async () => { throw new Error('not called'); } },
      () => true, () => decision + minute);
    driver.seedWarmup([candle(decision - 2 * minute)]);
    await expect(driver.onFinalizedCandle(candle(decision))).rejects.toThrow('Missing/duplicate');
    expect(driver.status().faulted).toBe(true);
  });
  it('journals a natural NO_ACTION without inventing an execution trade', async () => {
    const activationAt = decision - 1000;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    let writes = 0;
    const driver = new CausalShadowDriver(activationAt, decision - 500,
      { predict: async (_rows, end) => ({ decisionTimestamp: end, featureCutoff: end,
        side: 'NO_ACTION', confidence: .8, actionable: false, flipActionable: false,
        modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash }) },
      { snapshot: () => state, process: async () => {
        writes++;
        return { status: 'NO_ACTION', entry: false, exit: false };
      } }, () => true, () => decision + 1000);
    driver.seedWarmup(Array.from({ length: 11_999 }, (_, i) =>
      candle(decision - (11_999 - i) * minute)));
    expect(await driver.onFinalizedCandle(candle(decision))).toBe('NO_ACTION_RECORDED');
    expect(driver.status().pendingDecision).toBeNull();
    expect(writes).toBe(1);
  });
  it('does not commit or pend a signal if source readiness is lost during inference', async () => {
    const activationAt = decision - 1000;
    const state = new ShadowEngine(activationAt, 100, 1).state;
    let fresh = true;
    let writes = 0;
    const driver = new CausalShadowDriver(activationAt, decision - 500,
      { predict: async (_rows, end) => {
        fresh = false;
        return { decisionTimestamp: end, featureCutoff: end, side: 'LONG', confidence: .6,
          actionable: true, flipActionable: true, modelHash: FROZEN.directionModelHash,
          featureSchemaHash: FROZEN.featureSchemaHash };
      } },
      { snapshot: () => state, process: async () => { writes++;
        return { status: 'ENTRY', entry: true, exit: false }; } },
      () => fresh, () => decision + 1000);
    driver.seedWarmup(Array.from({ length: 11_999 }, (_, i) =>
      candle(decision - (11_999 - i) * minute)));
    await expect(driver.onFinalizedCandle(candle(decision))).rejects.toThrow('lost readiness');
    expect(writes).toBe(0);
    expect(driver.status()).toMatchObject({ pendingDecision: null, faulted: true });
  });
});
