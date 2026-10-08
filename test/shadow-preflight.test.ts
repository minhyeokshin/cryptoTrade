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
];

function pool(user: string, rows = allowed): pg.Pool {
  let queries = 0;
  return {
    query: async (sql: string) => {
      expect(sql.trim().startsWith('SELECT')).toBe(true);
      return {
        rows:
          ++queries === 1 ? [{ current_user: user, session_user: user }] : rows,
      };
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
      verifyShadowDbPreflight(pool('bybit_shadow', allowed.slice(0, 3))),
    ).rejects.toThrow('journal/report privilege');
    const mutation = allowed.map((x) =>
      x.table_name === 'node_shadow_journal' ? { ...x, can_update: true } : x,
    );
    await expect(
      verifyShadowDbPreflight(pool('bybit_shadow', mutation)),
    ).rejects.toThrow('journal/report privilege');
  });
});
