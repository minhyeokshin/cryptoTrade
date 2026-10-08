export interface HourlySnapshot {
  reportTimestamp: string; startTimestamp: string | null; currentEquity: number;
  totalTrades: number; wins: number; losses: number; winRate: number | null;
  profitFactor: number | null; expectancy: number | null; netPnl: number;
  returnPct: number; currentDrawdown: number; mdd: number; maxConsecutiveLosses: number;
  openPosition: boolean; openPositionSide: string | null; openPositionEntry: number | null;
  openPositionUnrealizedPnl: number | null; latestSignal: string | null;
  latestConfidence: number | null; sourceLastTradeTimestamp: string | null;
  sourceFreshness: boolean; processUptimeSeconds: number;
}
export function formatHourlyReport(s: HourlySnapshot): string {
  const fields: Record<string, string | number | boolean | null> = {
    REPORT_TIMESTAMP: s.reportTimestamp, FORWARD_SHADOW_START_TIMESTAMP: s.startTimestamp,
    CURRENT_EQUITY: s.currentEquity, TOTAL_TRADES: s.totalTrades, WINS: s.wins, LOSSES: s.losses,
    WIN_RATE: s.winRate, PROFIT_FACTOR: s.profitFactor, EXPECTANCY: s.expectancy,
    NET_PNL: s.netPnl, RETURN_PCT: s.returnPct, CURRENT_DRAWDOWN: s.currentDrawdown,
    MDD: s.mdd, MAX_CONSECUTIVE_LOSSES: s.maxConsecutiveLosses,
    OPEN_POSITION: s.openPosition, OPEN_POSITION_SIDE: s.openPositionSide,
    OPEN_POSITION_ENTRY: s.openPositionEntry, OPEN_POSITION_UNREALIZED_PNL: s.openPositionUnrealizedPnl,
    LATEST_SIGNAL: s.latestSignal, LATEST_CONFIDENCE: s.latestConfidence,
    SOURCE_LAST_TRADE_TIMESTAMP: s.sourceLastTradeTimestamp, SOURCE_FRESHNESS: s.sourceFreshness,
    PROCESS_UPTIME: s.processUptimeSeconds, ACTUAL_ORDERS: 0, PRIVATE_API_CALLS: 0,
    LIVE_TRADING_GATE: 'CLOSED',
  };
  return Object.entries(fields).map(([key, value]) => `${key}=${value ?? 'N/A'}`).join('\n') + '\n';
}
