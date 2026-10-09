import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { verifyShadowDbPreflight } from '../src/db/shadow-preflight.js';

const allowed = [
  {
    schema_name: 'bybit_live',
    table_name: 'bybit_live_trades',
    can_select: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
  },
  {
    schema_name: 'bybit_live',
    table_name: 'bybit_live_candles_1m',
    can_select: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
  },
  {
    schema_name: 'bybit_live',
    table_name: 'operational_health_events',
    can_select: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
  },
  {
    schema_name: 'bybit_live',
    table_name: 'node_producer_epochs',
    can_select: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
  },
  { schema_name: 'bybit_live', table_name: 'node_producer_heartbeats',
    can_select: true, can_insert: false, can_update: false, can_delete: false },
  { schema_name: 'bybit_live', table_name: 'node_live_epoch_boundaries',
    can_select: true, can_insert: false, can_update: false, can_delete: false },
  {
    schema_name: 'shadow_trading_v1',
    table_name: 'node_shadow_journal',
    can_select: true,
    can_insert: true,
    can_update: false,
    can_delete: false,
  },
  {
    schema_name: 'shadow_trading_v1',
    table_name: 'node_hourly_reports',
    can_select: true,
    can_insert: true,
    can_update: false,
    can_delete: false,
  },
  { schema_name: 'shadow_trading_v1', table_name: 'node_shadow_suspensions',
    can_select: true, can_insert: true, can_update: false, can_delete: false },
];

function pool(user: string, rows = allowed): pg.Pool {
  let queries = 0;
  return {
    query: async (sql: string) => {
      expect(sql.trim().startsWith('SELECT')).toBe(true);
      queries++;
      if (queries === 1) return { rows: [{ current_user: user, session_user: user }] };
      if (sql.includes('pg_catalog.pg_proc')) return { rows: [{ owner_name: 'postgres',
        security_definer: true, volatility: 'v', parallel_safety: 'u',
        settings: ['search_path=pg_catalog, pg_temp'], can_execute: true,
        public_execute: false, has_all_stats: false }] };
      return { rows };
    },
  } as unknown as pg.Pool;
}

describe('Shadow DB preflight', () => {
  it('accepts only a dedicated peer role with read-market/write-journal grants', async () => {
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow')),
    ).resolves.toBeUndefined();
  });
  it('rejects shared/research credentials', async () => {
    await expect(verifyShadowDbPreflight(pool('btcuser'))).rejects.toThrow(
      'Dedicated',
    );
  });
  it('rejects market or research write permission', async () => {
    const marketWrite = allowed.map((x) =>
      x.table_name === 'bybit_live_trades' ? { ...x, can_insert: true } : x,
    );
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow', marketWrite)),
    ).rejects.toThrow('market privilege');
    const researchWrite = [
      ...allowed,
      {
        ...allowed[0]!,
        schema_name: 'research',
        table_name: 'source',
        can_insert: true,
      },
    ];
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow', researchWrite)),
    ).rejects.toThrow('Unexpected Shadow write');
  });
  it('rejects missing journal grants and mutation rights', async () => {
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow', allowed.slice(0, 6))),
    ).rejects.toThrow('journal/report privilege');
    const mutation = allowed.map((x) =>
      x.table_name === 'node_shadow_journal' ? { ...x, can_update: true } : x,
    );
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow', mutation)),
    ).rejects.toThrow('journal/report privilege');
  });
  it('rejects a missing or broadly executable session verifier', async () => {
    const base = pool('bybit_shadow');
    const missing = { query: async (sql: string) => sql.includes('pg_catalog.pg_proc')
      ? { rows: [] } : base.query(sql) } as unknown as pg.Pool;
    await expect(verifyShadowDbPreflight(missing)).rejects.toThrow('session verifier');
    const broadBase = pool('bybit_shadow');
    const broad = { query: async (sql: string) => sql.includes('pg_catalog.pg_proc')
      ? { rows: [{ owner_name: 'postgres', security_definer: true,
        volatility: 'v', parallel_safety: 'u', settings: ['search_path=pg_catalog, pg_temp'],
        can_execute: true, public_execute: true, has_all_stats: false }] }
      : broadBase.query(sql) } as unknown as pg.Pool;
    await expect(verifyShadowDbPreflight(broad)).rejects.toThrow('session verifier');
  });
});
