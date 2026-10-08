import { Decimal } from 'decimal.js';
import type { CanonicalTrade, TradeSide } from '../types/domain.js';

export function canonicalMillis(value: string | number): number {
  const n = new Decimal(value).floor();
  if (!n.isFinite() || n.lte(0) || n.gt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid trade time');
  return n.toNumber();
}

export function normalizeWsTrade(input: unknown, receivedAt = Date.now()): CanonicalTrade {
  if (!input || typeof input !== 'object') throw new Error('Invalid trade payload');
  const x = input as Record<string, unknown>;
  if (x.s !== 'BTCUSD' || typeof x.i !== 'string' || !x.i) throw new Error('Invalid symbol or ID');
  if (x.S !== 'Buy' && x.S !== 'Sell') throw new Error('Invalid side');
  const price = new Decimal(String(x.p));
  const size = new Decimal(String(x.v));
  if (!price.isFinite() || price.lte(0) || !size.isFinite() || size.lte(0)) throw new Error('Invalid price/size');
  return {
    id: x.i, timestamp: canonicalMillis(String(x.T)), receivedAt,
    side: x.S as TradeSide, price: price.toString(), size: size.toString(),
    sequence: x.seq == null ? null : Number(x.seq), source: 'WEBSOCKET',
  };
}

export function sameTrade(a: CanonicalTrade, b: CanonicalTrade): boolean {
  return a.id === b.id && a.timestamp === b.timestamp && a.side === b.side &&
    new Decimal(a.price).eq(b.price) && new Decimal(a.size).eq(b.size);
}
