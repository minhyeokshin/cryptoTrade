import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import type { ProducerLease } from '../producer-lease.js';
import type { CanonicalTrade } from '../../types/domain.js';
import { decodeJournalFrame, encodeJournalFrame, type JournalFrame } from '../../market/journal-frame.js';
import { validateWsWitness } from '../../market/ws-ordering-witness.js';

type Row = {
  connection_id: string; message_ordinal: string; epoch_id: string;
  received_ms: string; exchange_message_id: string | null; message_sha256: string; raw_payload: string;
  first_receive_order: string; trade_count: number; min_timestamp: string; max_timestamp: string;
  witnesses: unknown;
};
const columns = `j.*,m.exchange_message_id,m.message_sha256,m.raw_payload,
  (extract(epoch FROM m.received_at)*1000)::bigint::text AS received_ms`;
const join = `bybit_live.node_ws_journal_frames j JOIN bybit_live.node_ws_messages m
  ON (m.connection_id,m.message_ordinal)=(j.connection_id,j.message_ordinal)`;
function frame(row: Row): JournalFrame {
  return { connectionId: row.connection_id, messageOrdinal: Number(row.message_ordinal),
    receivedAt: Number(row.received_ms), exchangeMessageId: row.exchange_message_id,
    messageHash: row.message_sha256, rawMessage: row.raw_payload,
    firstReceiveOrder: Number(row.first_receive_order), tradeCount: row.trade_count,
    minTimestamp: Number(row.min_timestamp), maxTimestamp: Number(row.max_timestamp), witnesses: row.witnesses };
}

/** All operations use the lock-owning session, and never overlap canonical transactions. */
export class WsJournal {
  constructor(private readonly lease: ProducerLease) {}

  async append(trades: CanonicalTrade[]): Promise<void> {
    const f = encodeJournalFrame(trades);
    return this.lease.withSession(async () => {
      const epoch = this.lease.boundEpoch;
      const client = this.lease.client;
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL synchronous_commit=on");
        await client.query("SET LOCAL statement_timeout='5s'");
        const existing = await client.query<Row>(`SELECT ${columns} FROM ${join}
          WHERE j.connection_id=$1 AND j.message_ordinal=$2`, [f.connectionId, f.messageOrdinal]);
        if (existing.rows.length) {
          const row = existing.rows[0]!;
          decodeJournalFrame(frame(row));
          if (row.epoch_id !== epoch || !isDeepStrictEqual(frame(row), f))
            throw new Error('Conflicting journal frame identity');
        } else {
          const prior = await client.query<Row>(`SELECT ${columns} FROM ${join}
            WHERE j.connection_id=$1 ORDER BY j.message_ordinal DESC LIMIT 1`, [f.connectionId]);
          const p = prior.rows[0];
          if (p) decodeJournalFrame(frame(p));
          if (f.messageOrdinal !== (p ? Number(p.message_ordinal) + 1 : 1) ||
              f.firstReceiveOrder !== (p ? Number(p.first_receive_order) + p.trade_count : 1) ||
              (p && (p.epoch_id !== epoch || f.minTimestamp < Number(p.max_timestamp))))
            throw new Error('Journal connection coverage/order gap');
          // Legacy messages may exist, but cannot silently become journal evidence.
          await client.query(`INSERT INTO bybit_live.node_ws_messages
            (connection_id,message_ordinal,received_at,exchange_message_id,message_sha256,raw_payload)
            VALUES ($1,$2,to_timestamp($3::double precision/1000),$4,$5,$6)`,
          [f.connectionId,f.messageOrdinal,f.receivedAt,f.exchangeMessageId,f.messageHash,f.rawMessage]);
          await client.query(`INSERT INTO bybit_live.node_ws_journal_frames
            (connection_id,message_ordinal,epoch_id,first_receive_order,trade_count,min_timestamp,max_timestamp,witnesses)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [f.connectionId,f.messageOrdinal,epoch,f.firstReceiveOrder,f.tradeCount,
            f.minTimestamp,f.maxTimestamp,JSON.stringify(f.witnesses)]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  }

  async replay(since: number): Promise<CanonicalTrade[]> {
    if (!Number.isSafeInteger(since)) throw new Error('Invalid replay boundary');
    return this.lease.withSession(async () => {
      const result = await this.lease.client.query<Row>(`SELECT ${columns} FROM ${join}
        WHERE j.epoch_id=$1 AND j.max_timestamp >= $2
        ORDER BY j.connection_id,j.message_ordinal LIMIT 10001`, [this.lease.boundEpoch, since]);
      if (result.rows.length > 10000) throw new Error('Journal replay exceeds bounded frame limit');
      const prior = new Map<string, JournalFrame>();
      const trades: CanonicalTrade[] = [];
      for (const row of result.rows) {
        const f = frame(row), p = prior.get(f.connectionId);
        if (p && (f.messageOrdinal !== p.messageOrdinal + 1 ||
            f.firstReceiveOrder !== p.firstReceiveOrder + p.tradeCount || f.minTimestamp < p.maxTimestamp))
          throw new Error('Journal replay connection coverage gap');
        trades.push(...decodeJournalFrame(f));
        prior.set(f.connectionId, f);
      }
      return trades.filter((t) => t.timestamp >= since);
    });
  }

  /** Called inside canonical transaction: durable full-frame evidence is mandatory. */
  static async requireCommitted(client: pg.PoolClient, trades: CanonicalTrade[], epoch: string): Promise<void> {
    const checked = new Map<string, CanonicalTrade[]>();
    for (const t of trades.filter((t) => t.source === 'WEBSOCKET')) {
      const w = validateWsWitness(t), key = `${w.connectionId}:${w.messageOrdinal}`;
      if (!checked.has(key)) {
        const result = await client.query<Row>(`SELECT ${columns} FROM ${join}
          WHERE j.connection_id=$1 AND j.message_ordinal=$2 AND j.epoch_id=$3`,
        [w.connectionId,w.messageOrdinal,epoch]);
        if (result.rows.length !== 1) throw new Error('Canonical frame lacks committed journal');
        checked.set(key, decodeJournalFrame(frame(result.rows[0]!)));
      }
      const original = checked.get(key)![w.messageIndex];
      if (!isDeepStrictEqual(original, t)) throw new Error('Canonical/journal trade mismatch');
    }
  }
}
