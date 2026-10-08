import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { MarketRepository } from '../src/db/repositories/market.js';
import type { CanonicalCandle, CanonicalTrade } from '../src/types/domain.js';

const trade: CanonicalTrade = { id: 'same-id', timestamp: 60_001, receivedAt: 60_002,
  side: 'Buy', price: '100.0000000001', size: '2.0000000001', sequence: 1, source: 'REST_RECENT' };
const candle: CanonicalCandle = { end: 120_000, open: '100', high: '101', low: '100',
  close: '101', volume: '2', tradeCount: 1, firstTradeTimestamp: 60_001,
  lastTradeTimestamp: 60_001 };

function fakePool(price = trade.price, inserted = false, failWitness = false): {
  pool: pg.Pool; statements: string[] } {
  const statements: string[] = [];
  const client = { release: () => {}, query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('ON CONFLICT (trade_id)')) return { rowCount: inserted ? 1 : 0, rows: [] };
    if (sql.includes('INSERT INTO bybit_live.node_ws_messages')) return { rowCount: 1, rows: [] };
    if (sql.includes('INSERT INTO bybit_live.node_ws_trade_witnesses')) {
      if (failWitness) throw new Error('witness write failed');
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM bybit_live.bybit_live_trades')) return { rowCount: 1,
      rows: [{ ts_ms: 60_001, side: 'Buy', price, size: trade.size, source: 'REST_RECENT' }] };
    if (sql.includes('ON CONFLICT (timestamp)')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM bybit_live.bybit_live_candles_1m')) return { rowCount: 1,
      rows: [{ open: '100.0', high: '101.0', low: '100.0', close: '101.0',
        volume: '2.0', trade_count: '1', first_ms: '60001', last_ms: '60001' }] };
    return { rowCount: 0, rows: [] };
  } };
  return { pool: { connect: async () => client } as unknown as pg.Pool, statements };
}

describe('append-only market persistence', () => {
  const rawMessage = JSON.stringify({ topic: 'publicTrade.BTCUSD', data: [{
    i: trade.id, T: String(trade.timestamp), seq: trade.sequence, s: 'BTCUSD',
    S: trade.side, p: trade.price, v: trade.size,
  }] });
  const wsTrade: CanonicalTrade = { ...trade, source: 'WEBSOCKET', witness: {
    connectionId: 'f14bf07e-a0b7-4105-baa7-92473d9022c2',
    messageOrdinal: 1, messageIndex: 0, receiveOrder: 1,
    receivedAt: trade.receivedAt,
    messageHash: createHash('sha256').update(rawMessage).digest('hex'),
    rawMessage, exchangeMessageId: null,
  } };
  it('accepts exact duplicate IDs/candles without mutation', async () => {
    const { pool, statements } = fakePool();
    await new MarketRepository(pool).persist(candle, [trade]);
    await new MarketRepository(pool).persist(candle, [trade]);
    await new MarketRepository(pool).persist(candle, [trade]);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((s) => /\bUPDATE\b|\bDELETE\b/.test(s))).toBe(false);
    expect(statements.filter((s) => s.includes('ON CONFLICT (trade_id)'))).toHaveLength(3);
  });
  it('rejects a conflicting existing trade even below binary-float precision', async () => {
    const { pool, statements } = fakePool('100.0000000002');
    await expect(new MarketRepository(pool).persist(candle, [trade])).rejects.toThrow('Conflicting persisted trade ID');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
  it('commits operational health in the same append-only candle transaction', async () => {
    const { pool, statements } = fakePool();
    await new MarketRepository(pool).persist(candle, [trade], 'HEALTHY');
    expect(statements.some((sql) => sql.includes('INSERT INTO bybit_live.operational_health_events')))
      .toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((sql) => /\bUPDATE\b|\bDELETE\b/.test(sql))).toBe(false);
  });
  it('atomically commits a new WS trade, raw frame, per-trade order witness and candle', async () => {
    const { pool, statements } = fakePool(trade.price, true);
    await new MarketRepository(pool).persist(candle, [wsTrade], 'HEALTHY');
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some((s) => s.includes('INSERT INTO bybit_live.node_ws_messages'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO bybit_live.node_ws_trade_witnesses'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.some((s) => /\bUPDATE\b|\bDELETE\b/.test(s))).toBe(false);
  });
  it('rolls back the canonical trade if its WS witness write fails', async () => {
    const { pool, statements } = fakePool(trade.price, true, true);
    await expect(new MarketRepository(pool).persist(candle, [wsTrade])).rejects.toThrow('witness write failed');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });
  it('rejects a missing or tampered WS witness before HEALTHY', async () => {
    const { pool, statements } = fakePool(trade.price, true);
    await expect(new MarketRepository(pool).persist(candle, [{ ...wsTrade, witness: undefined }],
      'HEALTHY')).rejects.toThrow('witness missing');
    await expect(new MarketRepository(pool).persist(candle, [{ ...wsTrade,
      witness: { ...wsTrade.witness!, messageHash: '0'.repeat(64) } }],
    'HEALTHY')).rejects.toThrow('metadata/hash');
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(0);
  });
  it('fails closed when a persisted WS trade has no durable ordering witness', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    await expect(new MarketRepository(pool).verifyPersistedWsWitnesses([wsTrade]))
      .rejects.toThrow('Persisted WS ordering witness absent');
  });
  it('does not require a WS witness for an official REST-origin canonical trade', async () => {
    const pool = { query: async () => { throw new Error('unexpected DB query'); } } as unknown as pg.Pool;
    await expect(new MarketRepository(pool).verifyPersistedWsWitnesses([trade]))
      .resolves.toBeUndefined();
  });
});
