import type { Side } from '../types/domain.js';

export interface ClosedTradeMetric { side: Side; netBtc: number; netUsd: number; holdingSeconds: number; }
function ratio(n: number, d: number): number | null { return d === 0 ? null : n / d; }
function std(values: number[]): number { const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length); }

export function tradeMetrics(trades: ClosedTradeMetric[], initialEquity = 100, currentEquity = initialEquity) {
  const n = trades.length;
  const winners = trades.filter((x) => x.netBtc > 0);
  const losers = trades.filter((x) => x.netBtc < 0);
  const grossProfit = winners.reduce((a, x) => a + x.netBtc, 0);
  const grossLoss = -losers.reduce((a, x) => a + x.netBtc, 0);
  let losing = 0, maxLosing = 0, winning = 0, maxWinning = 0;
  for (const trade of trades) {
    losing = trade.netBtc < 0 ? losing + 1 : 0;
    winning = trade.netBtc > 0 ? winning + 1 : 0;
    maxLosing = Math.max(maxLosing, losing); maxWinning = Math.max(maxWinning, winning);
  }
  const returns = trades.map((x) => x.netUsd / initialEquity);
  const downside = Math.sqrt(returns.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / (n || 1));
  const mean = returns.reduce((a, b) => a + b, 0) / (n || 1);
  return {
    totalTrades: n, wins: winners.length, losses: losers.length, breakeven: n - winners.length - losers.length,
    winRate: ratio(winners.length, n), grossProfitBtc: grossProfit, grossLossBtc: grossLoss,
    profitFactor: ratio(grossProfit, grossLoss),
    averageWinnerBtc: ratio(grossProfit, winners.length), averageLoserBtc: ratio(-grossLoss, losers.length),
    payoffRatio: ratio(ratio(grossProfit, winners.length) ?? 0, -(ratio(-grossLoss, losers.length) ?? 0)),
    expectancyBtc: ratio(trades.reduce((a, x) => a + x.netBtc, 0), n),
    netPnlUsd: trades.reduce((a, x) => a + x.netUsd, 0), returnPct: (currentEquity / initialEquity - 1) * 100,
    currentEquity, maxConsecutiveWins: maxWinning, maxConsecutiveLosses: maxLosing,
    sharpePerTrade: n > 1 ? ratio(mean, std(returns)) : null,
    sortinoPerTrade: n > 1 ? ratio(mean, downside) : null,
    averageHoldingSeconds: ratio(trades.reduce((a, x) => a + x.holdingSeconds, 0), n),
  };
}

export function longShortMetrics(trades: ClosedTradeMetric[], equity: number) {
  return { long: tradeMetrics(trades.filter((x) => x.side === 'LONG'), 100, equity),
    short: tradeMetrics(trades.filter((x) => x.side === 'SHORT'), 100, equity) };
}
