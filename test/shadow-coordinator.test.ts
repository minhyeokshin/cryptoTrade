import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowEngine, type ShadowState } from '../src/shadow/shadow-engine.js';
import { ShadowCoordinator, type ShadowJournal } from '../src/shadow/shadow-coordinator.js';

const activationId = '00000000-0000-4000-8000-000000000002';
function fixture() {
  let committed: ShadowState = structuredClone(new ShadowEngine(0, 100, 1).state);
  let fail = false;
  const journal: ShadowJournal = {
    restore: async () => ({ activationId, lastSignalTimestamp: null, state: structuredClone(committed) }),
    persistTransition: async (_id, _signal, _timestamp, state) => {
      if (fail) throw new Error('DB unavailable');
      committed = structuredClone(state);
      return 'COMMITTED';
    },
  };
  const prediction = (decisionTimestamp: number) => ({ decisionTimestamp,
    featureCutoff: decisionTimestamp, side: 'LONG' as const, confidence: .6,
    actionable: true, flipActionable: true, modelHash: FROZEN.directionModelHash,
    featureSchemaHash: FROZEN.featureSchemaHash });
  return { journal, prediction, setFail: (value: boolean) => { fail = value; } };
}

describe('Shadow coordinator commit boundary', () => {
  it('does not expose an entry until append-only journal commits', async () => {
    const f = fixture();
    const coordinator = await ShadowCoordinator.resume(f.journal, activationId, 0, 100, 1);
    f.setFail(true);
    await expect(coordinator.process(f.prediction(300_000), 300_001, 100, 100, true))
      .rejects.toThrow('DB unavailable');
    expect(coordinator.snapshot().open).toBeNull();
    f.setFail(false);
    expect(await coordinator.process(f.prediction(300_000), 300_001, 100, 100, true))
      .toMatchObject({ status: 'ENTRY', entry: true });
    expect(coordinator.snapshot().open?.contracts).toBe(36);
    const restarted = await ShadowCoordinator.resume(f.journal, activationId, 0, 100, 1);
    expect(await restarted.process(f.prediction(300_000), 300_001, 100, 100, true))
      .toMatchObject({ status: 'DUPLICATE', entry: false });
  });
  it('blocks all state transitions on stale source', async () => {
    const f = fixture();
    const coordinator = await ShadowCoordinator.resume(f.journal, activationId, 0, 100, 1);
    expect(await coordinator.process(f.prediction(300_000), 300_001, 100, 100, false))
      .toMatchObject({ status: 'SOURCE_BLOCKED', entry: false });
    expect(coordinator.snapshot().processedSignals).toEqual([]);
  });
});
