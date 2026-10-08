import type { CanonicalTrade } from '../types/domain.js';
import { sameTrade } from './trade-normalizer.js';

export interface Reconciliation {
  recovered: CanonicalTrade[];
  overlap: number;
  anchorTimestamp: number;
  latestTimestamp: number;
}

/** Recent public REST is bounded; absence of the exact pre-disconnect anchor is a hard gap. */
export function reconcileRecent(anchor: CanonicalTrade, rest: CanonicalTrade[],
                                resumedWs: CanonicalTrade[]): Reconciliation {
  if (!rest.length || !resumedWs.length) throw new Error('REST/WS data unavailable');
  const byId = new Map<string, CanonicalTrade>();
  for (const trade of rest) {
    const old = byId.get(trade.id);
    if (old && !sameTrade(old, trade)) throw new Error('Conflicting REST trade ID');
    byId.set(trade.id, trade);
  }
  const restAnchor = byId.get(anchor.id);
  if (!restAnchor || !sameTrade(restAnchor, anchor)) throw new Error('Pre-disconnect anchor absent or mismatched');
  const wsById = new Map<string, CanonicalTrade>();
  for (const trade of resumedWs) {
    const old = wsById.get(trade.id);
    if (old && !sameTrade(old, trade)) throw new Error('Conflicting resumed WS trade ID');
    wsById.set(trade.id, trade);
  }
  let overlap = 0;
  for (const trade of byId.values()) {
    const wsTrade = wsById.get(trade.id);
    if (wsTrade) {
      if (!sameTrade(trade, wsTrade)) throw new Error('REST/WS trade mismatch');
      if (trade.timestamp >= anchor.timestamp && trade.id !== anchor.id) overlap++;
    }
  }
  if (overlap === 0) throw new Error('No post-anchor REST/WS overlap');
  const later = [...byId.values()].filter((trade) =>
    trade.timestamp > anchor.timestamp ||
    (trade.timestamp === anchor.timestamp && trade.id !== anchor.id &&
      trade.sequence !== null && anchor.sequence !== null && trade.sequence > anchor.sequence));
  // Equal-timestamp trades without an ordering sequence cannot prove which side of the anchor they belong to.
  if ([...byId.values()].some((trade) => trade.id !== anchor.id &&
      trade.timestamp === anchor.timestamp &&
      (trade.sequence === null || anchor.sequence === null || trade.sequence === anchor.sequence))) {
    throw new Error('Ambiguous equal-timestamp anchor ordering');
  }
  const recovered = later.filter((trade) => !wsById.has(trade.id)).sort((a, b) =>
    a.timestamp - b.timestamp || (a.sequence ?? 0) - (b.sequence ?? 0));
  return { recovered, overlap, anchorTimestamp: anchor.timestamp,
    latestTimestamp: Math.max(...[...byId.values()].map((trade) => trade.timestamp)) };
}
