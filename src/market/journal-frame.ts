import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CanonicalTrade } from '../types/domain.js';
import { normalizeWsTrade } from './trade-normalizer.js';
import { validateWsWitness } from './ws-ordering-witness.js';

export interface JournalFrame {
  connectionId: string; messageOrdinal: number; receivedAt: number;
  exchangeMessageId: string | null; messageHash: string; rawMessage: string;
  firstReceiveOrder: number; tradeCount: number; minTimestamp: number; maxTimestamp: number;
  witnesses: unknown;
}
const tuples = (trades: CanonicalTrade[]) => trades.map((t) =>
  [t.id, t.timestamp, t.sequence, t.price, t.size, t.side, t.witness!.messageIndex, t.witness!.receiveOrder]);

export function decodeJournalFrame(frame: JournalFrame): CanonicalTrade[] {
  if (!Number.isSafeInteger(frame.firstReceiveOrder) || frame.firstReceiveOrder < 1 ||
      createHash('sha256').update(frame.rawMessage).digest('hex') !== frame.messageHash)
    throw new Error('Journal frame hash/order mismatch');
  const parsed = JSON.parse(frame.rawMessage) as { topic?: string; id?: string; data?: unknown[] };
  if (parsed.topic !== 'publicTrade.BTCUSD' || !Array.isArray(parsed.data) || !parsed.data.length ||
      parsed.data.length !== frame.tradeCount || (parsed.id ?? null) !== frame.exchangeMessageId)
    throw new Error('Incomplete journal frame coverage');
  const trades = parsed.data.map((raw, index): CanonicalTrade => ({
    ...normalizeWsTrade(raw, frame.receivedAt), witness: {
      connectionId: frame.connectionId, messageOrdinal: frame.messageOrdinal,
      messageIndex: index, receiveOrder: frame.firstReceiveOrder + index,
      receivedAt: frame.receivedAt, exchangeMessageId: frame.exchangeMessageId,
      messageHash: frame.messageHash, rawMessage: frame.rawMessage,
    },
  }));
  trades.forEach(validateWsWitness);
  if (new Set(trades.map((t) => t.id)).size !== trades.length ||
      trades.some((t, i) => i > 0 && t.timestamp < trades[i - 1]!.timestamp) ||
      Math.min(...trades.map((t) => t.timestamp)) !== frame.minTimestamp ||
      Math.max(...trades.map((t) => t.timestamp)) !== frame.maxTimestamp ||
      !isDeepStrictEqual(tuples(trades), frame.witnesses))
    throw new Error('Journal witness coverage/payload/order mismatch');
  return trades;
}

export function encodeJournalFrame(trades: CanonicalTrade[]): JournalFrame {
  const first = trades[0];
  if (!first) throw new Error('Empty journal frame');
  const w = validateWsWitness(first);
  const frame: JournalFrame = { connectionId: w.connectionId, messageOrdinal: w.messageOrdinal,
    receivedAt: w.receivedAt, exchangeMessageId: w.exchangeMessageId,
    messageHash: w.messageHash, rawMessage: w.rawMessage, firstReceiveOrder: w.receiveOrder,
    tradeCount: trades.length, minTimestamp: Math.min(...trades.map((t) => t.timestamp)),
    maxTimestamp: Math.max(...trades.map((t) => t.timestamp)), witnesses: tuples(trades) };
  const decoded = decodeJournalFrame(frame);
  if (!isDeepStrictEqual(decoded, trades)) throw new Error('Mixed/partial journal frame');
  return frame;
}
