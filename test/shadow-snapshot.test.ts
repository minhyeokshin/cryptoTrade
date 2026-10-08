import { describe, expect, it } from 'vitest';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { ShadowSnapshotProvider } from '../src/report/shadow-snapshot.js';
import type { FrozenPrediction } from '../src/types/domain.js';

function prediction(
  decisionTimestamp: number,
  side: FrozenPrediction['side'],
): FrozenPrediction {
  return {
    decisionTimestamp,
    featureCutoff: decisionTimestamp,
    side,
    confidence: side === 'NO_ACTION' ? 0 : 0.6,
    actionable:
      side !== 'NO_ACTION' && decisionTimestamp % FROZEN.horizonMs === 0,
    flipActionable: side !== 'NO_ACTION',
    modelHash: FROZEN.directionModelHash,
    featureSchemaHash: FROZEN.featureSchemaHash,
  };
}

describe('committed-state hourly snapshot', () => {
  it('formats a zero-trade heartbeat without fabricating a signal or profit', async () => {
    const engine = new ShadowEngine(0, 100, 1);
    const provider = new ShadowSnapshotProvider(
      () => structuredClone(engine.state),
      () => ({
        latestTradeTimestamp: 3_600_000,
        sourceFresh: true,
        markPrice: 100,
      }),
      () => null,
      () => 61,
    );
    const snapshot = await provider.snapshot(new Date('1970-01-01T01:00:05Z'));
    expect(snapshot).toMatchObject({
      currentEquity: 100,
      totalTrades: 0,
      winRate: null,
      profitFactor: null,
      expectancy: null,
      netPnl: 0,
      openPosition: false,
      latestSignal: null,
      sourceFreshness: true,
      processUptimeSeconds: 61,
    });
  });

  it('marks an open inverse position and reports realized closed-trade metrics', async () => {
    const engine = new ShadowEngine(0, 100, 1);
    engine.consume(prediction(300_000, 'LONG'), 300_001, 100, 100, true);
    const openProvider = new ShadowSnapshotProvider(
      () => structuredClone(engine.state),
      () => ({
        latestTradeTimestamp: 360_000,
        sourceFresh: true,
        markPrice: 110,
      }),
      () => prediction(300_000, 'LONG'),
      () => 1,
    );
    const open = await openProvider.snapshot(new Date(360_000));
    expect(open.openPosition).toBe(true);
    expect(open.openPositionSide).toBe('LONG');
    expect(open.openPositionUnrealizedPnl).toBeGreaterThan(0);
    expect(open.latestConfidence).toBe(0.6);

    engine.consume(prediction(600_000, 'NO_ACTION'), 600_001, 110, 110, true);
    const closedProvider = new ShadowSnapshotProvider(
      () => structuredClone(engine.state),
      () => ({
        latestTradeTimestamp: 660_000,
        sourceFresh: true,
        markPrice: 110,
      }),
      () => null,
      () => 2,
    );
    const closed = await closedProvider.snapshot(new Date(660_000));
    expect(closed.totalTrades).toBe(1);
    expect(closed.wins).toBe(1);
    expect(closed.profitFactor).toBeNull();
    expect(closed.expectancy).toBeCloseTo(engine.state.closed[0]!.netUsd);
  });

  it('fails closed if marked state lacks a public price', async () => {
    const engine = new ShadowEngine(0, 100, 1);
    const provider = new ShadowSnapshotProvider(
      () => engine.state,
      () => ({
        latestTradeTimestamp: null,
        sourceFresh: false,
        markPrice: null,
      }),
      () => null,
    );
    await expect(provider.snapshot(new Date(600_000))).rejects.toThrow(
      'valid public mark',
    );
  });
});
