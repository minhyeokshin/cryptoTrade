import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ShadowStateStore } from '../src/shadow/state-store.js';
import type { Position } from '../src/shadow/shadow-engine.js';

const activation = '00000000-0000-4000-8000-000000000001';
const epoch = '00000000-0000-4000-8000-000000000002';
const otherEpoch = '00000000-0000-4000-8000-000000000003';

describe('append-only suspension idempotency', () => {
  it('accepts an identical retry without a second row and rejects changed epoch/reason/position', async () => {
    let stored: unknown[] | null = null;
    let inserts = 0;
    const pool = { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO shadow_trading_v1.node_shadow_suspensions')) {
        if (stored) return { rowCount: 0, rows: [] };
        stored = params;
        inserts++;
        return { rowCount: 1, rows: [{ activation_id: activation }] };
      }
      if (sql.includes('AS identical')) return { rowCount: 1,
        rows: [{ identical: stored !== null && stored.every((value, i) => value === params[i]) }] };
      throw new Error('Unexpected query');
    } } as unknown as pg.Pool;
    const store = new ShadowStateStore(pool);
    await store.suspend(activation, epoch, null, 'producer failed');
    await store.suspend(activation, epoch, null, 'producer failed');
    expect(inserts).toBe(1);
    await expect(store.suspend(activation, otherEpoch, null, 'producer failed'))
      .rejects.toThrow('Conflicting Shadow suspension');
    await expect(store.suspend(activation, epoch, null, 'different fault'))
      .rejects.toThrow('Conflicting Shadow suspension');
    await expect(store.suspend(activation, epoch, { signalId: 'changed' } as Position, 'producer failed'))
      .rejects.toThrow('Conflicting Shadow suspension');
    expect(inserts).toBe(1);
  });

  it('fails closed when conflict verification cannot read the existing row', async () => {
    const pool = { query: async (sql: string) => sql.includes('INSERT INTO')
      ? { rowCount: 0, rows: [] } : Promise.reject(new Error('DB lookup failed')) } as unknown as pg.Pool;
    await expect(new ShadowStateStore(pool).suspend(activation, epoch, null, 'fault'))
      .rejects.toThrow('DB lookup failed');
  });
});
