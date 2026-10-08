import { Decimal } from 'decimal.js';
import type { CanonicalCandle, CanonicalTrade } from '../types/domain.js';
import { canonicalMillis } from './trade-normalizer.js';

const BASE = 'https://api.bybit.com/v5/market/';
async function publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (!url.pathname.startsWith('/v5/market/')) throw new Error('Only public market REST allowed');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Public REST HTTP ${response.status}`);
  const body = await response.json() as { retCode: number; result: T };
  if (body.retCode !== 0) throw new Error(`Public REST retCode ${body.retCode}`);
  return body.result;
}

export async function recentTrades(receivedAt = Date.now()): Promise<CanonicalTrade[]> {
  const data = await publicGet<{ list: Array<Record<string, string>> }>('recent-trade',
    { category: 'inverse', symbol: 'BTCUSD', limit: '1000' });
  return data.list.map((x) => {
    if (!x.execId || (x.side !== 'Buy' && x.side !== 'Sell')) throw new Error('Invalid public trade');
    const price = new Decimal(x.price ?? 'NaN'); const size = new Decimal(x.size ?? 'NaN');
    if (!price.isFinite() || price.lte(0) || !size.isFinite() || size.lte(0)) throw new Error('Invalid trade price/size');
    return { id: x.execId, timestamp: canonicalMillis(x.time ?? ''), receivedAt,
      side: x.side, price: price.toString(), size: size.toString(),
      sequence: x.seq == null ? null : Number(x.seq), source: 'REST_RECENT' as const };
  });
}

export async function officialOneMinute(end: number): Promise<CanonicalCandle> {
  const start = end - 60_000;
  const data = await publicGet<{ list: string[][] }>('kline', {
    category: 'inverse', symbol: 'BTCUSD', interval: '1',
    start: String(start), end: String(start + 59_999), limit: '1',
  });
  const x = data.list.find((row) => Number(row[0]) === start);
  if (!x) throw new Error('Official completed 1m kline unavailable');
  const values = x.slice(1, 6).map((v) => new Decimal(v ?? 'NaN'));
  if (values.some((v) => !v.isFinite() || v.lt(0))) throw new Error('Invalid official kline');
  return { end, open: values[0]?.toString() ?? '', high: values[1]?.toString() ?? '',
    low: values[2]?.toString() ?? '', close: values[3]?.toString() ?? '',
    volume: values[4]?.toString() ?? '', tradeCount: 0,
    firstTradeTimestamp: null, lastTradeTimestamp: null };
}

export async function publicContractSpec(): Promise<{ lotSize: number; mark: number }> {
  const [instruments, ticker] = await Promise.all([
    publicGet<{ list: Array<{ lotSizeFilter: { qtyStep: string } }> }>('instruments-info', { category: 'inverse', symbol: 'BTCUSD' }),
    publicGet<{ list: Array<{ markPrice: string }> }>('tickers', { category: 'inverse', symbol: 'BTCUSD' }),
  ]);
  const lotSize = Number(instruments.list[0]?.lotSizeFilter.qtyStep);
  const mark = Number(ticker.list[0]?.markPrice);
  if (!Number.isInteger(lotSize) || lotSize < 1 || !Number.isFinite(mark) || mark <= 0) throw new Error('Invalid official contract spec');
  return { lotSize, mark };
}
