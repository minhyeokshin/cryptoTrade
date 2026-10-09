import type { CanonicalTrade } from '../types/domain.js';
import { sameTrade } from './trade-normalizer.js';
import { validateWsWitness } from './ws-ordering-witness.js';

/** UUIDs never rank trades. A complete group must have one connected WS witness. */
export function witnessedGroup(group: CanonicalTrade[], evidence: CanonicalTrade[]): CanonicalTrade[] {
  const ids = new Set(group.map((t) => t.id));
  const connections = new Map<string, Map<string, CanonicalTrade>>();
  for (const t of evidence.filter((t) => ids.has(t.id))) {
    const original = group.find((g) => g.id === t.id)!;
    if (!sameTrade(original, t) || original.sequence !== t.sequence)
      throw new Error('Journal/REST payload mismatch');
    const w = validateWsWitness(t);
    const connection = connections.get(w.connectionId) ?? new Map<string, CanonicalTrade>();
    const prior = connection.get(t.id);
    if (!prior || prior.witness!.receiveOrder > w.receiveOrder) connection.set(t.id, t);
    connections.set(w.connectionId, connection);
  }
  const complete: CanonicalTrade[][] = [];
  for (const members of connections.values()) {
    if (members.size !== ids.size) continue;
    const ordered = [...members.values()].sort((a,b) => a.witness!.receiveOrder - b.witness!.receiveOrder);
    for (let i=1; i<ordered.length; i++) {
      const a=ordered[i-1]!.witness!, b=ordered[i]!.witness!;
      if (b.receiveOrder <= a.receiveOrder || b.messageOrdinal < a.messageOrdinal ||
          (b.messageOrdinal === a.messageOrdinal && b.messageIndex <= a.messageIndex))
        throw new Error('Contradictory journal ordering witness');
    }
    complete.push(ordered);
  }
  if (!complete.length) throw new Error('Incomplete journal group ordering witness');
  if (complete.some((ordered) => ordered.some((t,i) => t.id !== complete[0]![i]!.id)))
    throw new Error('Conflicting complete WS group orders');
  return complete[0]!;
}

export function orderReplay(trades: CanonicalTrade[], evidence: CanonicalTrade[]): CanonicalTrade[] {
  const unique = new Map<string, CanonicalTrade>();
  for (const t of trades) {
    const prior=unique.get(t.id);
    if (prior && (!sameTrade(prior,t) || prior.sequence !== t.sequence))
      throw new Error('Conflicting replay ID');
    if (!prior) unique.set(t.id,t);
  }
  const groups = new Map<string, CanonicalTrade[]>();
  for (const t of unique.values()) {
    const key=`${t.timestamp}:${t.sequence}`;
    groups.set(key,[...(groups.get(key) ?? []),t]);
  }
  return [...groups.values()].sort((a,b) => a[0]!.timestamp-b[0]!.timestamp ||
    (a[0]!.sequence ?? -1)-(b[0]!.sequence ?? -1)).flatMap((g) =>
    g.length > 1 ? witnessedGroup(g,evidence) : g);
}
