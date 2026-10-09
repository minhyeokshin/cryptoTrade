import type pg from 'pg';

type PrivilegeRow = { schema_name: string; table_name: string; can_select: boolean;
  can_insert: boolean; can_update: boolean; can_delete: boolean };
const REQUIRED = ['bybit_live_trades', 'bybit_live_candles_1m',
  'operational_health_events', 'node_producer_epochs', 'node_live_epoch_boundaries',
  'node_producer_heartbeats', 'node_ws_messages', 'node_ws_trade_witnesses',
  'node_ws_journal_frames'] as const;

/** Catalog-only permission audit on the actual dedicated peer session. */
export async function verifyProducerDbPreflight(pool: pg.Pool): Promise<void> {
  const identity = await pool.query<{ current_user: string; session_user: string }>(
    'SELECT current_user, session_user');
  if (identity.rows.length !== 1 || identity.rows[0]?.current_user !== 'bybit_producer' ||
      identity.rows[0]?.session_user !== 'bybit_producer') {
    throw new Error('Dedicated bybit_producer peer session required');
  }
  const grants = await pool.query<PrivilegeRow>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name,
           has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
           has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
           has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
           has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg_%'
     ORDER BY n.nspname,c.relname`);
  const byName = new Map(grants.rows.map((row) => [`${row.schema_name}.${row.table_name}`, row]));
  for (const name of REQUIRED) {
    const row = byName.get(`bybit_live.${name}`);
    if (!row?.can_select || !row.can_insert || row.can_update || row.can_delete) {
      throw new Error(`Producer market privilege mismatch: ${name}`);
    }
  }
  for (const row of grants.rows) {
    if (row.can_update || row.can_delete ||
        (row.can_insert && row.schema_name !== 'bybit_live')) {
      throw new Error(`Unexpected Producer write privilege: ${row.schema_name}.${row.table_name}`);
    }
  }
}
