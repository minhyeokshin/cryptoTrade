import type { CanonicalTrade } from '../types/domain.js';
import { sameTrade } from './trade-normalizer.js';

const sameIdentityAndSequence = (a: CanonicalTrade, b: CanonicalTrade): boolean =>
  sameTrade(a, b) && (a.sequence === null || b.sequence === null || a.sequence === b.sequence);

export interface Reconciliation {
  recovered: CanonicalTrade[];
  overlap: number;
  anchorTimestamp: number;
  latestTimestamp: number;
}

/** A millisecond is a bucket, not a unique order key. Persisted members of the anchor bucket
 * are verified by ID/payload; only a strictly greater exchange sequence proves a new member
 * happened after the persisted tail. Trade IDs have no lexical ordering semantics. */
export function reconcileRecent(anchor: CanonicalTrade, rest: CanonicalTrade[],
  resumedWs: CanonicalTrade[], persistedAnchorTimestampTrades: CanonicalTrade[] = [anchor]): Reconciliation {
  if (!rest.length || !resumedWs.length) throw new Error('REST/WS data unavailable');
  const unique = (source: CanonicalTrade[], label: string): Map<string, CanonicalTrade> => {
    const result = new Map<string, CanonicalTrade>();
    for (const trade of source) {
      const old = result.get(trade.id);
      if (old && !sameIdentityAndSequence(old, trade)) throw new Error(`Conflicting ${label} trade ID`);
      if (old && label === 'REST') throw new Error('Duplicate REST trade ID');
      result.set(trade.id, trade);
    }
    return result;
  };
  const byId = unique(rest, 'REST');
  const restAnchor = byId.get(anchor.id);
  if (!restAnchor || !sameIdentityAndSequence(restAnchor, anchor)) throw new Error('Pre-disconnect anchor absent or mismatched');
  const persisted = unique(persistedAnchorTimestampTrades, 'persisted');
  if (!persisted.has(anchor.id) || persistedAnchorTimestampTrades.some((trade) => {
    const recent = byId.get(trade.id);
    return trade.timestamp !== anchor.timestamp || !recent || !sameIdentityAndSequence(recent, trade);
  })) {
    throw new Error('Persisted anchor millisecond group mismatch');
  }
  // An anchor at the 1,000-trade REST window edge cannot prove the whole bucket was returned.
  if (!rest.some((trade) => trade.timestamp < anchor.timestamp)) {
    throw new Error('REST window does not cover full anchor millisecond group');
  }
  const wsById = unique(resumedWs, 'resumed WS');
  const latestRestTimestamp = Math.max(...rest.map((trade) => trade.timestamp));
  for (const trade of wsById.values()) {
    if (trade.timestamp >= anchor.timestamp && trade.timestamp < latestRestTimestamp &&
        !byId.has(trade.id)) {
      throw new Error('REST/WS missing trade ID within covered interval');
    }
  }
  const persistedSequences = persistedAnchorTimestampTrades.map((trade) => trade.sequence);
  const maxPersistedSequence = persistedSequences.every((seq) => seq !== null) ?
    Math.max(...persistedSequences as number[]) : null;
  const candidates: CanonicalTrade[] = [];
  for (const trade of byId.values()) {
    if (trade.timestamp < anchor.timestamp) continue;
    if (trade.timestamp === anchor.timestamp && persisted.has(trade.id)) continue;
    if (trade.timestamp === anchor.timestamp &&
        (maxPersistedSequence === null || trade.sequence === null ||
          trade.sequence <= maxPersistedSequence)) {
      throw new Error('Ambiguous equal-timestamp anchor ordering');
    }
    candidates.push(trade);
  }
  // Bybit documents that multiple executions may share seq; such a pair cannot order prices.
  const sequenceKeys = new Set<string>();
  for (const trade of candidates) {
    if (trade.sequence === null || !Number.isSafeInteger(trade.sequence))
      throw new Error('Missing or invalid post-anchor exchange sequence');
    const key = `${trade.timestamp}:${trade.sequence}`;
    if (sequenceKeys.has(key)) throw new Error('Ambiguous post-anchor exchange sequence');
    sequenceKeys.add(key);
  }
  candidates.sort((a, b) => a.timestamp - b.timestamp || a.sequence! - b.sequence!);
  const overlapTrades = candidates.filter((trade) => wsById.has(trade.id));
  if (!overlapTrades.length) throw new Error('No post-anchor REST/WS overlap');
  for (const trade of overlapTrades) {
    if (!sameIdentityAndSequence(trade, wsById.get(trade.id)!)) throw new Error('REST/WS trade mismatch');
  }
  return { recovered: candidates.filter((trade) => !wsById.has(trade.id)),
    overlap: overlapTrades.length, anchorTimestamp: anchor.timestamp,
    latestTimestamp: latestRestTimestamp };
}
