import { Decimal } from 'decimal.js';
import type { CanonicalCandle, CanonicalTrade } from '../types/domain.js';
import { sameTrade } from './trade-normalizer.js';

export const MINUTE = 60_000;
export function endLabel(timestamp: number): number { return Math.floor(timestamp / MINUTE) * MINUTE + MINUTE; }

export function aggregate(trades: CanonicalTrade[], end: number, previousClose: string): CanonicalCandle | null {
  if (end % MINUTE !== 0 || !new Decimal(previousClose).gt(0)) throw new Error('Invalid canonical boundary/previous close');
  const selected = trades.map((trade, index) => ({ trade, index }))
    .filter(({ trade }) => trade.timestamp >= end - MINUTE && trade.timestamp < end)
    .sort((a, b) => a.trade.timestamp - b.trade.timestamp ||
      (a.trade.sequence ?? 0) - (b.trade.sequence ?? 0) || a.index - b.index);
  if (!selected.length) return null;
  const prices = selected.map(({ trade }) => new Decimal(trade.price));
  const close = prices.at(-1);
  const first = selected[0];
  const last = selected.at(-1);
  if (!close || !first || !last) throw new Error('Unreachable empty candle');
  const prior = new Decimal(previousClose);
  return {
    end, open: prior.toString(),
    high: Decimal.max(prior, ...prices).toString(), low: Decimal.min(prior, ...prices).toString(),
    close: close.toString(),
    volume: selected.reduce((sum, x) => sum.plus(x.trade.size), new Decimal(0)).toString(),
    tradeCount: selected.length,
    firstTradeTimestamp: first.trade.timestamp, lastTradeTimestamp: last.trade.timestamp,
  };
}

export class CandleBuilder {
  private readonly trades = new Map<string, CanonicalTrade>();
  private readonly finalized = new Set<number>();
  duplicateCount = 0;
  orderingViolations = 0;
  lateCount = 0;
  private latestTimestamp = -Infinity;

  discardBefore(start: number): void {
    if (!Number.isSafeInteger(start) || start % MINUTE !== 0 || this.finalized.size) {
      throw new Error('Invalid new live epoch boundary');
    }
    for (const [id, trade] of this.trades) if (trade.timestamp < start) this.trades.delete(id);
  }

  ingest(trade: CanonicalTrade, recovered = false): 'ACCEPTED' | 'DUPLICATE' | 'LATE' {
    const old = this.trades.get(trade.id);
    if (old) {
      if (!sameTrade(old, trade)) throw new Error('Conflicting trade ID');
      this.duplicateCount++;
      return 'DUPLICATE';
    }
    if (!recovered && trade.timestamp < this.latestTimestamp) this.orderingViolations++;
    this.latestTimestamp = Math.max(this.latestTimestamp, trade.timestamp);
    if (this.finalized.has(endLabel(trade.timestamp))) { this.lateCount++; return 'LATE'; }
    this.trades.set(trade.id, trade);
    return 'ACCEPTED';
  }

  finalize(end: number, now: number, previousClose: string, official?: CanonicalCandle): CanonicalCandle {
    if (now < end || this.finalized.has(end)) throw new Error('Unfinished or duplicate candle');
    let candle = aggregate([...this.trades.values()], end, previousClose);
    if (!candle) {
      if (!official || official.end !== end || official.volume !== '0' ||
          !['open', 'high', 'low', 'close'].every((key) => new Decimal(official[key as keyof CanonicalCandle] as string).eq(previousClose))) {
        throw new Error('Empty minute lacks official verification');
      }
      candle = { ...official, tradeCount: 0, firstTradeTimestamp: null, lastTradeTimestamp: null };
    }
    if (official && !['open', 'high', 'low', 'close', 'volume'].every((key) =>
      new Decimal(candle[key as keyof CanonicalCandle] as string).eq(official[key as keyof CanonicalCandle] as string))) {
      throw new Error('Official kline mismatch');
    }
    this.finalized.add(end);
    for (const [id, trade] of this.trades) if (trade.timestamp < end) this.trades.delete(id);
    return candle;
  }
}
