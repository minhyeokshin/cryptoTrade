import type { RuntimeView } from './routes/health.js';
import type { MarketReadRepository } from '../db/repositories/market-read.js';
import type { ShadowStateStore } from '../shadow/state-store.js';
import { sourceSnapshotFresh } from '../shadow/market-observer.js';
import { ShadowSnapshotProvider } from '../report/shadow-snapshot.js';

type MarketReader = Pick<MarketReadRepository, 'sourceState' | 'warmupBefore'>;
type JournalReader = Pick<ShadowStateStore, 'restore'>;

/** SELECT-only view. Journal presence proves an activation record, never a live process. */
export function shadowDbView(market: MarketReader, journal: JournalReader,
                             activationId: string, now: () => number = Date.now): RuntimeView {
  const marketStatus = async () => {
    const state = await market.sourceState();
    return { ...state, databaseSourceFresh: sourceSnapshotFresh(state, now()),
      publicWsVerified: false, sourceFresh: false };
  };
  const snapshot = async () => {
    const at = now();
    const [source, restored, candles] = await Promise.all([
      market.sourceState(), journal.restore(activationId), market.warmupBefore(at, 1),
    ]);
    const mark = candles.at(-1)?.close;
    const databaseSourceFresh = sourceSnapshotFresh(source, at);
    // A stale canonical mark cannot value an open inverse position as "current" equity.
    if (restored && (!databaseSourceFresh || mark === undefined)) {
      return { restored, report: null, databaseSourceFresh };
    }
    const provider = new ShadowSnapshotProvider(() => restored?.state ?? null,
      () => ({ latestTradeTimestamp: source.latestTrade, sourceFresh: false,
        markPrice: mark === undefined ? null : Number(mark) }), () => null, () => 0);
    const report = await provider.snapshot(new Date(at));
    return { restored, report, databaseSourceFresh };
  };
  return {
    health: async () => ({ status: 'not_ready', components: {
      process: 'up', database: 'up', bybitWs: 'not_verified', sourceFresh: false,
      inference: 'not_verified', shadowEngine: 'runtime_not_verified', hourlyReport: 'not_verified',
    } }),
    market: marketStatus,
    shadow: async () => {
      const { restored, report, databaseSourceFresh } = await snapshot();
      return { forwardShadowStarted: false, activationRecorded: restored !== null,
        runtimeVerified: false, databaseSourceFresh,
        activationTimestamp: restored ? new Date(restored.state.activationAt).toISOString() : null,
        equity: report?.currentEquity ?? null, trades: restored?.state.closed.length ?? 0,
        winRate: report?.winRate ?? null, profitFactor: report?.profitFactor ?? null,
        mdd: report?.mdd ?? null, openPosition: restored?.state.open ?? null, sourceFresh: false };
    },
    metrics: async () => {
      const { restored, report, databaseSourceFresh } = await snapshot();
      return { status: report ? 'RUNTIME_NOT_VERIFIED' : 'SOURCE_STALE',
        activationRecorded: restored !== null, databaseSourceFresh,
        totalTrades: restored?.state.closed.length ?? 0, wins: report?.wins ?? null,
        losses: report?.losses ?? null, winRate: report?.winRate ?? null,
        profitFactor: report?.profitFactor ?? null, expectancy: report?.expectancy ?? null,
        netPnl: report?.netPnl ?? null, returnPct: report?.returnPct ?? null,
        currentEquity: report?.currentEquity ?? null,
        currentDrawdown: report?.currentDrawdown ?? null,
        mdd: report?.mdd ?? null, maxConsecutiveLosses: report?.maxConsecutiveLosses ?? null };
    },
    trades: async () => (await journal.restore(activationId))?.state.closed ?? [],
  };
}
