import { FROZEN } from '../config/frozen.js';
import { grossBtc } from '../shadow/inverse-pnl.js';
import type { ShadowState } from '../shadow/shadow-engine.js';
import type { FrozenPrediction } from '../types/domain.js';
import type { HourlySnapshot } from './hourly-report.js';
import type { SnapshotProvider } from './hourly-scheduler.js';

export interface OperationalSourceSnapshot {
  latestTradeTimestamp: number | null;
  sourceFresh: boolean;
  markPrice: number | null;
}

/** Builds a live-only heartbeat from committed Shadow state; it never reads historical performance. */
export class ShadowSnapshotProvider implements SnapshotProvider {
  constructor(
    private readonly state: () => ShadowState | null,
    private readonly source: () => OperationalSourceSnapshot,
    private readonly latestPrediction: () => FrozenPrediction | null,
    private readonly uptimeSeconds: () => number = process.uptime,
  ) {}

  async snapshot(at: Date): Promise<HourlySnapshot> {
    if (!Number.isFinite(at.getTime()))
      throw new Error('Invalid report timestamp');
    const state = this.state();
    const source = this.source();
    const mark = source.markPrice;
    if (state && (!Number.isFinite(mark) || mark === null || mark <= 0)) {
      throw new Error('Committed Shadow snapshot requires a valid public mark');
    }
    const open = state?.open ?? null;
    const unrealizedBtc =
      open && mark !== null
        ? grossBtc(open.contracts, open.executionEntry, mark, open.side)
        : 0;
    const equity =
      state && mark !== null
        ? (state.balanceBtc + unrealizedBtc) * mark
        : FROZEN.initialEquityUsd;
    if (!Number.isFinite(equity))
      throw new Error('Invalid marked Shadow equity');
    const trades = state?.closed ?? [];
    const wins = trades.filter((trade) => trade.netUsd > 0);
    const losses = trades.filter((trade) => trade.netUsd < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.netUsd, 0);
    const grossLoss = -losses.reduce((sum, trade) => sum + trade.netUsd, 0);
    let losingStreak = 0;
    let maxLosingStreak = 0;
    for (const trade of trades) {
      losingStreak = trade.netUsd < 0 ? losingStreak + 1 : 0;
      maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    }
    const currentDrawdown = state
      ? Math.max(0, 1 - equity / state.peakEquity)
      : 0;
    const prediction = this.latestPrediction();
    return {
      reportTimestamp: at.toISOString(),
      startTimestamp: state ? new Date(state.activationAt).toISOString() : null,
      currentEquity: equity,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : null,
      profitFactor: grossLoss ? grossProfit / grossLoss : null,
      expectancy: trades.length
        ? trades.reduce((sum, trade) => sum + trade.netUsd, 0) / trades.length
        : null,
      netPnl: equity - FROZEN.initialEquityUsd,
      returnPct: (equity / FROZEN.initialEquityUsd - 1) * 100,
      currentDrawdown,
      mdd: state ? Math.max(state.mdd, currentDrawdown) : 0,
      maxConsecutiveLosses: maxLosingStreak,
      openPosition: Boolean(open),
      openPositionSide: open?.side ?? null,
      openPositionEntry: open?.executionEntry ?? null,
      openPositionUnrealizedPnl:
        open && mark !== null ? unrealizedBtc * mark : null,
      latestSignal: prediction?.side ?? null,
      latestConfidence: prediction?.confidence ?? null,
      sourceLastTradeTimestamp:
        source.latestTradeTimestamp === null
          ? null
          : new Date(source.latestTradeTimestamp).toISOString(),
      sourceFreshness: source.sourceFresh,
      processUptimeSeconds: this.uptimeSeconds(),
    };
  }
}
