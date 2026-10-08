import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { MarketReadRepository } from '../src/db/repositories/market-read.js';

const row = (end: number) => ({ end_ms: String(end), open: '100.0', high: '101.0',
  low: '99.0', close: '100.5', volume: '2', trade_count: '1',
  first_ms: String(end - 10_000), last_ms: String(end - 10_000) });

describe('dedicated Shadow market reader', () => {
  it('returns chronological warmup without any write query', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => {
      queries.push(sql);
      return { rows: [row(120_000), row(60_000)] };
    } } as unknown as pg.Pool;
    const rows = await new MarketReadRepository(pool).warmupBefore(180_000, 2);
    expect(rows.map((x) => x.end)).toEqual([60_000, 120_000]);
    expect(queries.every((sql) => sql.trim().startsWith('SELECT'))).toBe(true);
  });
  it('rejects malformed persisted OHLC and an excessive cursor range', async () => {
    const pool = { query: async () => ({ rows: [{ ...row(60_000), high: '99' }] }) } as unknown as pg.Pool;
    await expect(new MarketReadRepository(pool).finalizedAfter(0)).rejects.toThrow('Invalid persisted');
    await expect(new MarketReadRepository(pool).finalizedAfter(0, 101)).rejects.toThrow('Invalid candle cursor');
  });
  it('rejects invalid trade bounds and volume/count disagreement', async () => {
    for (const bad of [
      { first_ms: '-1' },
      { last_ms: '60000' },
      { volume: '0' },
      { trade_count: '0' },
    ]) {
      const pool = { query: async () => ({ rows: [{ ...row(60_000), ...bad }] }) } as unknown as pg.Pool;
      await expect(new MarketReadRepository(pool).finalizedAfter(0)).rejects.toThrow('Invalid persisted');
    }
  });
  it('reads the active operational health stream, not the legacy diagnostic health table', async () => {
    const queries: string[] = [];
    const pool = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('bybit_live_trades')) return { rows: [{ ms: '120000' }] };
      if (sql.includes('bybit_live_candles_1m')) return { rows: [{ ms: '120000', source_status: 'LIVE_CURRENT_EPOCH' }] };
      return { rows: [{ state: 'HEALTHY', at_ms: '120100' }] };
    } } as unknown as pg.Pool;
    expect(await new MarketReadRepository(pool).sourceState()).toEqual({ latestTrade: 120_000,
      latestCandle: 120_000, latestCandleStatus: 'LIVE_CURRENT_EPOCH',
      health: 'HEALTHY', healthAt: 120_100 });
    expect(queries[2]).toContain('bybit_live.operational_health_events');
    expect(queries.every((sql) => sql.trim().startsWith('SELECT'))).toBe(true);
  });
});
