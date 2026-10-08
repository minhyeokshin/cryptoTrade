import { createHash } from 'node:crypto';
import type { CanonicalTrade, WsOrderingWitness } from '../types/domain.js';
import { normalizeWsTrade, sameTrade } from './trade-normalizer.js';

/** Validate the immutable raw public WS frame before it can witness a canonical write. */
export function validateWsWitness(trade: CanonicalTrade): WsOrderingWitness {
  if (trade.source !== 'WEBSOCKET' || !trade.witness) throw new Error('WS ordering witness missing');
  const witness = trade.witness;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(witness.connectionId) ||
      !Number.isSafeInteger(witness.messageOrdinal) || witness.messageOrdinal < 1 ||
      !Number.isSafeInteger(witness.messageIndex) || witness.messageIndex < 0 ||
      !Number.isSafeInteger(witness.receiveOrder) || witness.receiveOrder < 1 ||
      !Number.isSafeInteger(witness.receivedAt) || witness.receivedAt !== trade.receivedAt ||
      !/^[0-9a-f]{64}$/.test(witness.messageHash) ||
      createHash('sha256').update(witness.rawMessage).digest('hex') !== witness.messageHash) {
    throw new Error('Invalid WS ordering witness metadata/hash');
  }
  let parsed: { topic?: string; id?: string; data?: unknown[] };
  try { parsed = JSON.parse(witness.rawMessage) as typeof parsed; }
  catch { throw new Error('Invalid raw WS message'); }
  if (parsed.topic !== 'publicTrade.BTCUSD' || !Array.isArray(parsed.data) ||
      witness.messageIndex >= parsed.data.length ||
      (parsed.id ?? null) !== witness.exchangeMessageId) {
    throw new Error('WS witness message/index mismatch');
  }
  const original = normalizeWsTrade(parsed.data[witness.messageIndex], witness.receivedAt);
  if (!sameTrade(original, trade) || original.sequence !== trade.sequence) {
    throw new Error('WS witness trade payload mismatch');
  }
  return witness;
}
