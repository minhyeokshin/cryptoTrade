import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowPersistentRuntime } from '../src/shadow/persistent-runtime.js';
import { ShadowEngine, type ShadowState } from '../src/shadow/shadow-engine.js';
import type { ShadowJournal } from '../src/shadow/shadow-coordinator.js';
import type { CanonicalCandle } from '../src/types/domain.js';

const decision = 780_000_000;
const activationAt = decision;
const activationId = '00000000-0000-4000-8000-000000000001';
const epoch = '00000000-0000-4000-8000-000000000002';
const suspension = { isSuspended: async () => false,
  hasUnresolvedOpenSuspension: async () => false,
  suspend: async () => {} };
const candle = (end: number): CanonicalCandle => ({
  end,
  open: '100',
  high: '100',
  low: '100',
  close: '100',
  volume: '1',
  tradeCount: 1,
  firstTradeTimestamp: end - 1,
  lastTradeTimestamp: end - 1,
});

describe('restore-only Shadow persistent runtime', () => {
  it('reports a failed durable suspension instead of silently swallowing it', async () => {
    let reported: unknown;
    const runtime = new ShadowPersistentRuntime(
      { ws: new EventEmitter(), start: async () => {}, stop: () => {},
        status: () => ({ sourceFresh: false, integrityFault: true }) },
      { sourceState: async () => { throw new Error('must not read'); },
        warmupBefore: async () => [], finalizedAfter: async () => [] },
      { start: async () => {}, stop: () => {}, predict: async () => {
        throw new Error('must not infer'); } },
      { restore: async () => null, persistTransition: async () => 'COMMITTED',
        isSuspended: async () => false, hasUnresolvedOpenSuspension: async () => false,
        suspend: async () => { throw new Error('suspension DB unavailable'); } },
      activationId, epoch, 1, async () => {}, (error) => { reported = error; });
    runtime.halt(new Error('producer stopped'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.status().faulted).toBe(true);
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as Error).message).toContain('durable suspension recording');
  });

  it('does not infer from warmup or replay a signal after restart', async () => {
    let clock = decision - 1000;
    let latest = decision - 60_000;
    let committed = new ShadowEngine(activationAt, 100, 1).state;
    let writes = 0;
    let predictions = 0;
    let marketStarts = 0;
    let modelStarts = 0;
    let roleChecks = 0;
    const journal: ShadowJournal = {
      ...suspension,
      restore: async () => ({
        activationId,
        state: structuredClone(committed),
        lastSignalTimestamp: committed.processedSignals.length
          ? decision
          : null,
      }),
      persistTransition: async (_id, _key, _at, state: ShadowState) => {
        writes++;
        committed = structuredClone(state);
        return 'COMMITTED';
      },
    };
    const reader = {
      sourceState: async () => ({
        latestTrade: clock - 100,
        latestCandle: latest,
        latestCandleStatus: 'HEALTHY',
        health: 'HEALTHY',
        healthAt: decision - 5000,
        producerEpochId: epoch, boundaryEpochId: epoch,
        firstCompleteMinuteStartMs: decision - 12_000 * 60_000,
        heartbeatAt: clock - 100, heartbeatState: 'RUNNING', leaseHeld: true,
      }),
      warmupBefore: async (_cutoff: number, limit: number) =>
        limit === 1
          ? [candle(latest)]
          : Array.from({ length: 11_999 }, (_, i) =>
              candle(latest - (11_998 - i) * 60_000),
            ),
      finalizedAfter: async (cursor: number) =>
        cursor < latest ? [candle(latest)] : [],
    };
    const model = {
      start: async () => {
        modelStarts++;
      },
      stop: () => {},
      predict: async (_rows: CanonicalCandle[], timestamp: number) => {
        predictions++;
        return {
          decisionTimestamp: timestamp,
          featureCutoff: timestamp,
          side: 'NO_ACTION' as const,
          confidence: 0,
          actionable: false,
          flipActionable: false,
          modelHash: FROZEN.directionModelHash,
          featureSchemaHash: FROZEN.featureSchemaHash,
        };
      },
    };
    const makeRuntime = () =>
      new ShadowPersistentRuntime(
        {
          ws: new EventEmitter(),
          start: async () => {
            marketStarts++;
          },
          stop: () => {},
          status: () => ({ sourceFresh: true, integrityFault: false }),
        },
        reader,
        model,
        journal,
        activationId,
        epoch,
        1,
        async () => {
          roleChecks++;
        },
        () => {},
        () => clock,
      );

    const first = makeRuntime();
    await first.start(0);
    expect(predictions).toBe(0);
    expect(first.committedState()?.activationAt).toBe(activationAt);
    expect(first.reportSource()).toMatchObject({ markPrice: 100, sourceFresh: true });
    clock = decision + 1000;
    latest = decision;
    expect(await first.pollOnce()).toEqual(['NO_ACTION_RECORDED']);
    expect(writes).toBe(1);
    expect(first.latestSignal()?.side).toBe('NO_ACTION');
    first.stop();

    clock = decision + 2000;
    const restarted = makeRuntime();
    await restarted.start(0);
    expect(await restarted.pollOnce()).toEqual([]);
    expect(predictions).toBe(1);
    expect(writes).toBe(1);
    expect(restarted.status()).toMatchObject({
      started: true,
      faulted: false,
      lastCandle: decision,
    });
    restarted.stop();
    expect([marketStarts, modelStarts, roleChecks]).toEqual([2, 2, 2]);
  });

  it('fails before opening a public stream if activation or dedicated role is absent', async () => {
    let marketStarts = 0;
    const market = {
      ws: new EventEmitter(),
      start: async () => {
        marketStarts++;
      },
      stop: () => {},
      status: () => ({ sourceFresh: true, integrityFault: false }),
    };
    const reader = {
      sourceState: async () => {
        throw new Error('unreachable');
      },
      warmupBefore: async () => [],
      finalizedAfter: async () => [],
    };
    const model = {
      start: async () => {
        throw new Error('unreachable');
      },
      stop: () => {},
      predict: async () => {
        throw new Error('unreachable');
      },
    };
    const absent: ShadowJournal = {
      ...suspension,
      restore: async () => null,
      persistTransition: async () => {
        throw new Error('unreachable');
      },
    };
    const runtime = new ShadowPersistentRuntime(
      market,
      reader,
      model,
      absent,
      activationId,
      epoch,
      1,
      async () => {},
      () => {},
      () => decision,
    );
    await expect(runtime.start(0)).rejects.toThrow(
      'activation journal missing',
    );
    expect(marketStarts).toBe(0);
  });
  it('refuses to replay the first 5m decision if the approved activation time was missed', async () => {
    let marketStarts = 0;
    const runtime = new ShadowPersistentRuntime(
      { ws: new EventEmitter(), start: async () => { marketStarts++; }, stop: () => {},
        status: () => ({ sourceFresh: true, integrityFault: false }) },
      { sourceState: async () => { throw new Error('must not read'); },
        warmupBefore: async () => [], finalizedAfter: async () => [] },
      { start: async () => { throw new Error('must not load model'); }, stop: () => {},
        predict: async () => { throw new Error('must not infer'); } },
      { ...suspension, restore: async () => ({ activationId, lastSignalTimestamp: null,
          state: new ShadowEngine(activationAt, 100, 1).state }),
        persistTransition: async () => { throw new Error('must not write'); } },
      activationId, epoch, 1, async () => {}, () => {}, () => activationAt + 1000);
    await expect(runtime.start(0)).rejects.toThrow('activation decision already passed');
    expect(marketStarts).toBe(0);
  });

  it('suspends an open virtual position on a candle gap without settling PnL', async () => {
    const initial = new ShadowEngine(decision - 300_000, 100, 1);
    const prediction = { decisionTimestamp: decision, featureCutoff: decision,
      side: 'LONG' as const, confidence: 0.6, actionable: true, flipActionable: true,
      modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash };
    expect(initial.consume(prediction, decision + 1000, 100, 100, true).entry).not.toBeNull();
    let clock = decision + 20_000;
    let latest = decision;
    let suspension: ShadowState['open'] | undefined;
    let transitions = 0;
    const runtime = new ShadowPersistentRuntime(
      { ws: new EventEmitter(), start: async () => {}, stop: () => {},
        status: () => ({ sourceFresh: true, integrityFault: false }) },
      { sourceState: async () => ({ latestTrade: clock - 100, latestCandle: latest,
          latestCandleStatus: 'LIVE_CURRENT_EPOCH', health: 'HEALTHY', healthAt: clock - 100,
          producerEpochId: epoch, boundaryEpochId: epoch, heartbeatAt: clock - 100,
          firstCompleteMinuteStartMs: decision - 12_000 * 60_000,
          heartbeatState: 'RUNNING', leaseHeld: true }),
        warmupBefore: async (_cutoff: number, limit: number) => limit === 1 ? [candle(latest)] :
          Array.from({ length: 11_999 }, (_, i) => candle(latest - (11_998 - i) * 60_000)),
        finalizedAfter: async () => [candle(decision + 120_000)] },
      { start: async () => {}, stop: () => {}, predict: async () => {
        throw new Error('gap must not infer'); } },
      { restore: async () => ({ activationId, lastSignalTimestamp: decision,
          state: structuredClone(initial.state) }),
        persistTransition: async () => { transitions++; return 'COMMITTED' as const; },
        isSuspended: async () => false, hasUnresolvedOpenSuspension: async () => false,
        suspend: async (_id, _epoch, open) => { suspension = open; } },
      activationId, epoch, 1, async () => {}, () => {}, () => clock);
    await runtime.start(0);
    latest = decision + 120_000;
    clock = decision + 121_000;
    await expect(runtime.pollOnce()).rejects.toThrow('Missing/duplicate finalized candle');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.status()).toMatchObject({ faulted: true, suspended: true, started: false });
    expect(suspension).toMatchObject({ side: 'LONG', signalTimestamp: decision });
    expect(transitions).toBe(0);
    expect(runtime.committedState()?.closed).toHaveLength(0);
  });

  it('blocks automatic resume of a suspended activation before loading the model', async () => {
    let modelStarts = 0;
    const runtime = new ShadowPersistentRuntime(
      { ws: new EventEmitter(), start: async () => {}, stop: () => {},
        status: () => ({ sourceFresh: true, integrityFault: false }) },
      { sourceState: async () => { throw new Error('must not read'); },
        warmupBefore: async () => [], finalizedAfter: async () => [] },
      { start: async () => { modelStarts++; }, stop: () => {},
        predict: async () => { throw new Error('must not infer'); } },
      { restore: async () => ({ activationId, lastSignalTimestamp: null,
          state: new ShadowEngine(decision + 300_000, 100, 1).state }),
        persistTransition: async () => { throw new Error('must not write'); },
        isSuspended: async () => true, hasUnresolvedOpenSuspension: async () => false,
        suspend: async () => {} },
      activationId, epoch, 1, async () => {}, () => {}, () => decision);
    await expect(runtime.start(0)).rejects.toThrow('requires separate human resolution');
    expect(modelStarts).toBe(0);
  });
});
