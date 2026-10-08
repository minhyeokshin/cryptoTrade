import type pg from 'pg';
import { Decimal } from 'decimal.js';
import type { CanonicalCandle, CanonicalTrade } from '../../types/domain.js';
import type { ProducerLease } from '../producer-lease.js';
import { validateWsWitness } from '../../market/ws-ordering-witness.js';

export class MarketRepository {
  constructor(private readonly pool: pg.Pool, private readonly lease?: ProducerLease) {}
  async historicalGapStart(): Promise<number> {
    const result = await (this.lease?.client ?? this.pool).query<{ ms: string }>(
      `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS ms
         FROM bybit_live.bybit_live_trades ORDER BY exchange_timestamp DESC LIMIT 1`);
    const ms = Number(result.rows[0]?.ms);
    if (!Number.isSafeInteger(ms)) throw new Error('Canonical historical gap start unavailable');
    return ms;
  }
  async newEpochApprovalUsed(approvalId: string): Promise<boolean> {
    const result = await (this.lease?.client ?? this.pool).query(
      `SELECT 1 FROM bybit_live.node_live_epoch_boundaries WHERE approval_id=$1::uuid LIMIT 1`,
      [approvalId]);
    return result.rowCount === 1;
  }
  async recoveryTail(): Promise<{ lastCandleEnd: number; previousClose: string;
    lastTrade: CanonicalTrade; anchorTimestampTrades: CanonicalTrade[];
    unfinalizedTrades: CanonicalTrade[] }> {
    const client = this.lease?.client ?? await this.pool.connect();
    try {
      const candle = await client.query<{ end_ms: string; close: string }>(
        `SELECT (extract(epoch FROM timestamp)*1000)::bigint::text AS end_ms,close::text
           FROM bybit_live.bybit_live_candles_1m ORDER BY timestamp DESC LIMIT 1`);
      const tradeColumns = `trade_id,
        (extract(epoch FROM exchange_timestamp)*1000)::bigint::text AS timestamp_ms,
        (extract(epoch FROM received_at)*1000)::bigint::text AS received_ms,
        side,price::text,size::text,raw_sequence::text AS sequence,source`;
      type Row = { trade_id: string; timestamp_ms: string; received_ms: string;
        side: string; price: string; size: string; sequence: string | null; source: string };
      const tail = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          ORDER BY exchange_timestamp DESC,raw_sequence DESC NULLS LAST LIMIT 1`);
      if (!candle.rows[0] || !tail.rows[0]) throw new Error('Canonical producer tail unavailable');
      const end = Number(candle.rows[0].end_ms);
      const recent = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          WHERE exchange_timestamp >= to_timestamp($1::double precision/1000)
          ORDER BY exchange_timestamp,raw_sequence NULLS LAST LIMIT 1001`, [end]);
      if (recent.rows.length > 1000) throw new Error('Unfinalized canonical tail exceeds bounded recovery');
      const sameTimestamp = await client.query<Row>(
        `SELECT ${tradeColumns} FROM bybit_live.bybit_live_trades
          WHERE exchange_timestamp = to_timestamp($1::double precision/1000)
          ORDER BY raw_sequence NULLS LAST LIMIT 1001`, [tail.rows[0].timestamp_ms]);
      if (sameTimestamp.rows.length > 1000) throw new Error('Anchor millisecond group exceeds bounded recovery');
      const normalize = (row: Row): CanonicalTrade => {
        const timestamp = Number(row.timestamp_ms);
        const receivedAt = Number(row.received_ms);
        const sequence = row.sequence === null ? null : Number(row.sequence);
        if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(receivedAt) ||
            (sequence !== null && !Number.isSafeInteger(sequence)) ||
            (row.side !== 'Buy' && row.side !== 'Sell') ||
            !new Decimal(row.price).gt(0) || !new Decimal(row.size).gt(0)) {
          throw new Error('Invalid persisted producer trade tail');
        }
        return { id: row.trade_id, timestamp, receivedAt, side: row.side,
          price: row.price, size: row.size, sequence,
          source: row.source === 'WEBSOCKET' ? 'WEBSOCKET' : 'REST_RECENT' };
      };
      if (!Number.isSafeInteger(end) || end % 60_000 !== 0 ||
          !new Decimal(candle.rows[0].close).gt(0)) throw new Error('Invalid canonical candle tail');
      return { lastCandleEnd: end, previousClose: candle.rows[0].close,
        lastTrade: normalize(tail.rows[0]), anchorTimestampTrades: sameTimestamp.rows.map(normalize),
        unfinalizedTrades: recent.rows.map(normalize) };
    } finally { if (!this.lease) client.release(); }
  }
  /** Legacy WS rows without a durable witness cannot be promoted to restart-safe. */
  async verifyPersistedWsWitnesses(trades: CanonicalTrade[]): Promise<void> {
    const wsTrades = [...new Map(trades.filter((trade) => trade.source === 'WEBSOCKET')
      .map((trade) => [trade.id, trade])).values()];
    if (!wsTrades.length) return;
    type Row = { trade_id: string; connection_id: string; message_ordinal: string;
      message_index: number; receive_order: string; exchange_timestamp: Date;
      exchange_sequence: string | null; price: string; size: string; side: string;
      received_at: Date; exchange_message_id: string | null;
      message_sha256: string; raw_payload: string };
    const client = this.lease?.client ?? this.pool;
    const result = await client.query<Row>(
      `SELECT w.trade_id,w.connection_id::text,w.message_ordinal::text,w.message_index,
              w.receive_order::text,w.exchange_timestamp,w.exchange_sequence::text,
              w.price::text,w.size::text,w.side,m.received_at,m.exchange_message_id,
              m.message_sha256,m.raw_payload
         FROM bybit_live.node_ws_trade_witnesses w
         JOIN bybit_live.node_ws_messages m
           ON m.connection_id=w.connection_id AND m.message_ordinal=w.message_ordinal
        WHERE w.trade_id=ANY($1::text[])`, [wsTrades.map((trade) => trade.id)]);
    const byId = new Map(result.rows.map((row) => [row.trade_id, row]));
    const groups = new Map<string, Row[]>();
    for (const trade of wsTrades) {
      const row = byId.get(trade.id);
      if (!row) throw new Error(`Persisted WS ordering witness absent for ${trade.id}`);
      const witness = { connectionId: row.connection_id,
        messageOrdinal: Number(row.message_ordinal), messageIndex: row.message_index,
        receiveOrder: Number(row.receive_order), receivedAt: row.received_at.getTime(),
        messageHash: row.message_sha256, rawMessage: row.raw_payload,
        exchangeMessageId: row.exchange_message_id };
      validateWsWitness({ ...trade, witness });
      if (row.exchange_timestamp.getTime() !== trade.timestamp ||
          (row.exchange_sequence === null ? null : Number(row.exchange_sequence)) !== trade.sequence ||
          row.side !== trade.side || !new Decimal(row.price).eq(trade.price) ||
          !new Decimal(row.size).eq(trade.size)) {
        throw new Error(`Persisted WS witness/canonical mismatch for ${trade.id}`);
      }
      const key = `${trade.timestamp}:${trade.sequence ?? 'NULL'}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const connections = new Set(group.map((row) => row.connection_id));
      const orders = new Set(group.map((row) => row.receive_order));
      if (connections.size !== 1 || orders.size !== group.length) {
        throw new Error('Persisted tied WS group lacks one provable source order');
      }
      group.sort((a, b) => Number(a.receive_order) - Number(b.receive_order));
      if (group.some((row, index) => index > 0 &&
          (Number(row.message_ordinal) < Number(group[index - 1]!.message_ordinal) ||
            (row.message_ordinal === group[index - 1]!.message_ordinal &&
              row.message_index <= group[index - 1]!.message_index)))) {
        throw new Error('Persisted tied WS group order contradicts raw frame order');
      }
    }
  }
  async persist(candle: CanonicalCandle, trades: CanonicalTrade[],
                health?: 'WARMING' | 'HEALTHY' | 'STALE' | 'DEGRADED'): Promise<void> {
    const client = this.lease?.client ?? await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const trade of trades) {
        const witness = trade.source === 'WEBSOCKET' ? validateWsWitness(trade) : null;
        const result = await client.query<{ trade_id: string }>(
          `INSERT INTO bybit_live.bybit_live_trades
            (trade_id,exchange_timestamp,received_at,side,price,size,raw_sequence,source)
           VALUES ($1,to_timestamp($2::double precision/1000),to_timestamp($3::double precision/1000),$4,$5,$6,$7,$8)
           ON CONFLICT (trade_id) DO NOTHING RETURNING trade_id`,
          [trade.id, trade.timestamp, trade.receivedAt, trade.side, trade.price, trade.size,
            trade.sequence, trade.source]);
        if (!result.rowCount) {
          const old = await client.query<{ ts_ms: number; side: string; price: string;
            size: string; source: string }>(
            `SELECT (extract(epoch FROM exchange_timestamp)*1000)::bigint AS ts_ms,
                    side,price::text,size::text,source
               FROM bybit_live.bybit_live_trades WHERE trade_id=$1`, [trade.id]);
          const row = old.rows[0];
          if (!row || Number(row.ts_ms) !== trade.timestamp || row.side !== trade.side ||
              !new Decimal(row.price).eq(trade.price) || !new Decimal(row.size).eq(trade.size)) {
            throw new Error('Conflicting persisted trade ID');
          }
          if (row.source === 'WEBSOCKET') {
            const prior = await client.query(
              `SELECT 1 FROM bybit_live.node_ws_trade_witnesses WHERE trade_id=$1 LIMIT 1`, [trade.id]);
            if (!prior.rowCount) throw new Error('Persisted WS trade lacks immutable ordering witness');
          }
        } else if (witness) {
          const message = await client.query(
            `INSERT INTO bybit_live.node_ws_messages
              (connection_id,message_ordinal,received_at,exchange_message_id,message_sha256,raw_payload)
             VALUES ($1::uuid,$2,to_timestamp($3::double precision/1000),$4,$5,$6)
             ON CONFLICT (connection_id,message_ordinal) DO NOTHING RETURNING connection_id`,
            [witness.connectionId,witness.messageOrdinal,witness.receivedAt,
              witness.exchangeMessageId,witness.messageHash,witness.rawMessage]);
          if (!message.rowCount) {
            const existing = await client.query<{ message_sha256: string; raw_payload: string }>(
              `SELECT message_sha256,raw_payload FROM bybit_live.node_ws_messages
                WHERE connection_id=$1::uuid AND message_ordinal=$2`,
              [witness.connectionId,witness.messageOrdinal]);
            if (existing.rows[0]?.message_sha256 !== witness.messageHash ||
                existing.rows[0]?.raw_payload !== witness.rawMessage) {
              throw new Error('Conflicting immutable WS message');
            }
          }
          await client.query(
            `INSERT INTO bybit_live.node_ws_trade_witnesses
              (trade_id,connection_id,message_ordinal,message_index,receive_order,
               exchange_timestamp,exchange_sequence,price,size,side)
             VALUES ($1,$2::uuid,$3,$4,$5,to_timestamp($6::double precision/1000),$7,$8,$9,$10)`,
            [trade.id,witness.connectionId,witness.messageOrdinal,witness.messageIndex,
              witness.receiveOrder,trade.timestamp,trade.sequence,trade.price,trade.size,trade.side]);
        }
      }
      const inserted = await client.query(
        `INSERT INTO bybit_live.bybit_live_candles_1m
          (timestamp,open,high,low,close,volume,trade_count,first_trade_timestamp,
           last_trade_timestamp,finalized_at,source_status)
         VALUES (to_timestamp($1::double precision/1000),$2,$3,$4,$5,$6,$7,
           CASE WHEN $8::double precision IS NULL THEN NULL ELSE to_timestamp($8::double precision/1000) END,
           CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9::double precision/1000) END,
           clock_timestamp(),'LIVE_CURRENT_EPOCH')
         ON CONFLICT (timestamp) DO NOTHING RETURNING timestamp`,
        [candle.end,candle.open,candle.high,candle.low,candle.close,candle.volume,
          candle.tradeCount,candle.firstTradeTimestamp,candle.lastTradeTimestamp]);
      if (!inserted.rowCount) {
        const old = await client.query<{ open: string; high: string; low: string; close: string;
          volume: string; trade_count: string; first_ms: string | null; last_ms: string | null }>(
          `SELECT open::text,high::text,low::text,close::text,volume::text,trade_count::text,
                  (extract(epoch FROM first_trade_timestamp)*1000)::bigint::text AS first_ms,
                  (extract(epoch FROM last_trade_timestamp)*1000)::bigint::text AS last_ms
             FROM bybit_live.bybit_live_candles_1m
            WHERE timestamp=to_timestamp($1::double precision/1000)`, [candle.end]);
        const row = old.rows[0];
        if (!row || !new Decimal(row.open).eq(candle.open) || !new Decimal(row.high).eq(candle.high) ||
            !new Decimal(row.low).eq(candle.low) || !new Decimal(row.close).eq(candle.close) ||
            !new Decimal(row.volume).eq(candle.volume) || Number(row.trade_count) !== candle.tradeCount ||
            (row.first_ms === null ? null : Number(row.first_ms)) !== candle.firstTradeTimestamp ||
            (row.last_ms === null ? null : Number(row.last_ms)) !== candle.lastTradeTimestamp) {
          throw new Error('Conflicting persisted candle timestamp');
        }
      }
      if (health) await client.query(
        `INSERT INTO bybit_live.operational_health_events (state,reason)
         VALUES ($1,$2)`, [health, 'cryptoTrade-node canonical candle committed']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { if (!this.lease) client.release(); }
  }

  async recordFailure(reason: string): Promise<void> {
    if (!this.lease) return;
    await this.recordStartupHealth('FAILED', reason);
  }

  async recordStartupHealth(state: 'BACKFILLING' | 'FAILED', reason: string): Promise<void> {
    if (!this.lease) return;
    await this.lease.client.query(
      `INSERT INTO bybit_live.operational_health_events (state,reason)
       VALUES ($1,$2)`, [state, `cryptoTrade-node: ${reason.slice(0, 300)}`]);
  }
}
