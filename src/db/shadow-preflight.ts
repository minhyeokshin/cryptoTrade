import type pg from 'pg';

type PrivilegeRow = {
  schema_name: string;
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

const LIVE_TABLES = [
  'bybit_live_trades',
  'bybit_live_candles_1m',
  'operational_health_events',
] as const;
const SHADOW_TABLES = ['node_shadow_journal', 'node_hourly_reports'] as const;

/** Read-only catalog audit. Never SET ROLE: the connection must already be the peer-auth Shadow role. */
export async function verifyShadowDbPreflight(pool: pg.Pool): Promise<void> {
  const identity = await pool.query<{
    current_user: string;
    session_user: string;
  }>('SELECT current_user, session_user');
  if (
    identity.rows.length !== 1 ||
    identity.rows[0]?.current_user !== 'bybit_shadow' ||
    identity.rows[0]?.session_user !== 'bybit_shadow'
  ) {
    throw new Error('Dedicated bybit_shadow peer session required');
  }

  const result = await pool.query<PrivilegeRow>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name,
           has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
           has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
           has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
           has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_%'
     ORDER BY n.nspname, c.relname
  `);
  const byName = new Map(
    result.rows.map((row) => [`${row.schema_name}.${row.table_name}`, row]),
  );
  for (const table of LIVE_TABLES) {
    const row = byName.get(`bybit_live.${table}`);
    if (
      !row?.can_select ||
      row.can_insert ||
      row.can_update ||
      row.can_delete
    ) {
      throw new Error(`Shadow market privilege mismatch: ${table}`);
    }
  }
  for (const table of SHADOW_TABLES) {
    const row = byName.get(`shadow_trading_v1.${table}`);
    if (!row?.can_select || !row.can_insert || row.can_update || row.can_delete) {
      throw new Error(`Shadow journal/report privilege mismatch: ${table}`);
    }
  }
  for (const row of result.rows) {
    if (
      row.can_update ||
      row.can_delete ||
      (row.can_insert && row.schema_name !== 'shadow_trading_v1')
    ) {
      throw new Error(
        `Unexpected Shadow write privilege: ${row.schema_name}.${row.table_name}`,
      );
    }
  }
}
