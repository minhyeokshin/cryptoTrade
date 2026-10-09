import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { CanonicalCandle } from '../src/types/domain.js';
import { auditProducerSource } from '../src/market/source-audit.js';

const now = 720_120_000;
const rows = [720_060_000, 720_000_000, 719_940_000].map((end) => ({
  end_ms: String(end), open: '100', high: '101', low: '99', close: '100',
  volume: '2', source_status: 'LIVE_CURRENT_EPOCH',
}));
const official = async (end: number): Promise<CanonicalCandle> => ({ end,
  open: '100', high: '101', low: '99', close: '100', volume: '2', tradeCount: 0,
  firstTradeTimestamp: null, lastTradeTimestamp: null });
function fakePool(candles = rows, health = 'HEALTHY'): pg.Pool {
  return { query: async (sql: string) => {
    if (sql.includes('node_producer_epochs')) return { rows: [{ epoch_id: 'epoch', start_ms: '719900000' }] };
    if (sql.includes('bybit_live_trades')) return { rows: [{ ms: '720100000' }] };
    if (sql.includes('bybit_live_candles_1m')) return { rows: candles };
    if (sql.includes('operational_health_events')) return { rows: [{ state: health,
      reason: 'cryptoTrade-node canonical candle committed', at_ms: '720100000' }] };
    throw new Error('Unexpected operational query');
  } } as unknown as pg.Pool;
}

describe('Node live-epoch source audit', () => {
  it('binds to approved boundary instead of a later failed epoch and excludes partial candles', async () => {
    const queries: string[] = [];
    const base = fakePool();
    const pool = { query: async (sql: string, params: unknown[]) => {
      queries.push(sql);
      return base.query(sql, params);
    } } as unknown as pg.Pool;
    await auditProducerSource(pool, now, official);
    expect(queries[0]).toContain('node_live_epoch_boundaries');
    expect(queries[0]).toContain('ORDER BY recorded_at DESC, approval_id DESC');
    expect(queries[0]).not.toContain('ORDER BY epoch_start');
    expect(queries.find((sql) => sql.includes('bybit_live_candles_1m'))).toContain("interval '1 minute'");
  });
  it('requires three consecutive finalized candles with official OHLCV parity', async () => {
    const result = await auditProducerSource(fakePool(), now, official);
    expect(result).toMatchObject({ lastThreeConsecutive: true,
      officialKlineExactMatches: 3, sourceFresh: true, health: 'HEALTHY' });
  });
  it('fails closed on a missing minute or nonhealthy persisted producer state', async () => {
    expect((await auditProducerSource(fakePool([rows[0]!, rows[2]!]), now, official)).sourceFresh)
      .toBe(false);
    expect((await auditProducerSource(fakePool(rows, 'STALE'), now, official)).sourceFresh)
      .toBe(false);
  });
  it('fails closed on a public kline mismatch', async () => {
    const result = await auditProducerSource(fakePool(), now,
      async (end) => ({ ...(await official(end)), volume: '3' }));
    expect(result).toMatchObject({ officialKlineExactMatches: 0, sourceFresh: false });
  });
});
