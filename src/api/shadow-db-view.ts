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
    const provider = new ShadowSnapshotProvider(() => restored?.state ?? null,
      () => ({ latestTradeTimestamp: source.latestTrade, sourceFresh: false,
        markPrice: mark === undefined ? null : Number(mark) }), () => null, () => 0);
    const report = await provider.snapshot(new Date(at));
    return { restored, report, source };
  };
  return {
    health: async () => ({ status: 'not_ready', components: {
      process: 'up', database: 'up', bybitWs: 'not_verified', sourceFresh: false,
      inference: 'not_verified', shadowEngine: 'runtime_not_verified', hourlyReport: 'not_verified',
    } }),
    market: marketStatus,
    shadow: async () => {
      const { restored, report } = await snapshot();
      return { forwardShadowStarted: false, activationRecorded: restored !== null,
        runtimeVerified: false, activationTimestamp: report.startTimestamp,
        equity: report.currentEquity, trades: report.totalTrades, winRate: report.winRate,
        profitFactor: report.profitFactor, mdd: report.mdd, openPosition: restored?.state.open ?? null,
        sourceFresh: false };
    },
    metrics: async () => {
      const { restored, report } = await snapshot();
      return { status: 'RUNTIME_NOT_VERIFIED', activationRecorded: restored !== null,
        totalTrades: report.totalTrades, wins: report.wins, losses: report.losses,
        winRate: report.winRate, profitFactor: report.profitFactor,
        expectancy: report.expectancy, netPnl: report.netPnl, returnPct: report.returnPct,
        currentEquity: report.currentEquity, currentDrawdown: report.currentDrawdown,
        mdd: report.mdd, maxConsecutiveLosses: report.maxConsecutiveLosses };
    },
    trades: async () => (await journal.restore(activationId))?.state.closed ?? [],
  };
}
