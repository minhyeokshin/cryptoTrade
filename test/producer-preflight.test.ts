import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { verifyProducerDbPreflight } from '../src/db/producer-preflight.js';

const marketTables = ['bybit_live_trades', 'bybit_live_candles_1m',
  'operational_health_events', 'node_producer_epochs', 'node_live_epoch_boundaries',
  'node_producer_heartbeats'];
function fakePool(extra: { schema_name: string; table_name: string; can_select: boolean;
  can_insert: boolean; can_update: boolean; can_delete: boolean }[] = []): pg.Pool {
  return { query: async (sql: string) => sql.includes('current_user, session_user')
    ? { rows: [{ current_user: 'bybit_producer', session_user: 'bybit_producer' }] }
    : { rows: [...marketTables.map((table_name) => ({ schema_name: 'bybit_live',
      table_name, can_select: true, can_insert: true, can_update: false, can_delete: false })),
      ...extra] } } as unknown as pg.Pool;
}

describe('producer dedicated-role catalog preflight', () => {
  it('accepts least-privilege canonical insert grants', async () => {
    await expect(verifyProducerDbPreflight(fakePool())).resolves.toBeUndefined();
  });
  it('rejects research/source writes', async () => {
    await expect(verifyProducerDbPreflight(fakePool([{ schema_name: 'research',
      table_name: 'source', can_select: true, can_insert: true, can_update: false,
      can_delete: false }]))).rejects.toThrow('Unexpected Producer write');
  });
  it('rejects canonical UPDATE/DELETE grants', async () => {
    const pool = fakePool([{ schema_name: 'bybit_live', table_name: 'extra',
      can_select: true, can_insert: false, can_update: true, can_delete: false }]);
    await expect(verifyProducerDbPreflight(pool)).rejects.toThrow('Unexpected Producer write');
  });
});
