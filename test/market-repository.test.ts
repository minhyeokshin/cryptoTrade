import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { MarketRepository } from '../src/db/repositories/market.js';
import type { CanonicalCandle, CanonicalTrade } from '../src/types/domain.js';

const trade: CanonicalTrade = { id: 'same-id', timestamp: 60_001, receivedAt: 60_002,
  side: 'Buy', price: '100.0000000001', size: '2.0000000001', sequence: 1, source: 'WEBSOCKET' };
const candle: CanonicalCandle = { end: 120_000, open: '100', high: '101', low: '100',
  close: '101', volume: '2', tradeCount: 1, firstTradeTimestamp: 60_001,
  lastTradeTimestamp: 60_001 };

function fakePool(price = trade.price): { pool: pg.Pool; statements: string[] } {
  const statements: string[] = [];
  const client = { release: () => {}, query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('ON CONFLICT (trade_id)')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM bybit_live.bybit_live_trades')) return { rowCount: 1,
      rows: [{ ts_ms: 60_001, side: 'Buy', price, size: trade.size }] };
    if (sql.includes('ON CONFLICT (timestamp)')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM bybit_live.bybit_live_candles_1m')) return { rowCount: 1,
      rows: [{ open: '100.0', high: '101.0', low: '100.0', close: '101.0',
        volume: '2.0', trade_count: '1', first_ms: '60001', last_ms: '60001' }] };
    return { rowCount: 0, rows: [] };
  } };
  return { pool: { connect: async () => client } as unknown as pg.Pool, statements };
}

describe('append-only market persistence', () => {
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
});
