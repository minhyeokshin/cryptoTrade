import type { CanonicalTrade } from '../types/domain.js';
import { sameTrade } from './trade-normalizer.js';

/** REST is a parity witness, never an ordering source for a new WS-only epoch. */
export function verifyCurrentOverlap(rest: CanonicalTrade[], ws: CanonicalTrade[]): {
  overlap: number; firstVerified: CanonicalTrade;
} {
  const unique = (rows: CanonicalTrade[], name: string) => {
    const ids = new Map<string, CanonicalTrade>();
    for (const row of rows) {
      if (ids.has(row.id)) throw new Error(`Duplicate ${name} trade ID`);
      ids.set(row.id, row);
    }
    return ids;
  };
  const restById = unique(rest, 'REST');
  unique(ws, 'WS');
  let previousTimestamp = -Infinity;
  const verified: CanonicalTrade[] = [];
  for (const trade of ws) {
    if (trade.timestamp < previousTimestamp) throw new Error('Current WS ordering violation');
    previousTimestamp = trade.timestamp;
    const witness = restById.get(trade.id);
    if (!witness) continue;
    if (!sameTrade(trade, witness) ||
        (trade.sequence !== null && witness.sequence !== null && trade.sequence !== witness.sequence)) {
      throw new Error('Current REST/WS trade payload or sequence mismatch');
    }
    verified.push(trade);
  }
  if (!verified.length) throw new Error('Current REST/WS exact trade overlap absent');
  return { overlap: verified.length, firstVerified: verified[0]! };
}
