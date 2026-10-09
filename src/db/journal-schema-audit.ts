import type pg from 'pg';

/** Catalog-only checks. No advisory locks or test writes, even on missing schema. */
export async function verifyJournalSchema(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ table_name: string; definition: string }>(`
    SELECT n.nspname || '.' || r.relname AS table_name,
           pg_catalog.pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
     WHERE c.conrelid IN (to_regclass('bybit_live.node_ws_journal_frames'),
                         to_regclass('bybit_live.node_ws_trade_witnesses'))
       AND c.convalidated AND NOT c.condeferrable`);
  const constraints = [
    ['node_ws_journal_frames', 'PRIMARY KEY (connection_id, message_ordinal)'],
    ['node_ws_journal_frames', 'FOREIGN KEY (epoch_id) REFERENCES bybit_live.node_producer_epochs(epoch_id)'],
    ['node_ws_journal_frames', 'FOREIGN KEY (connection_id, message_ordinal) REFERENCES bybit_live.node_ws_messages(connection_id, message_ordinal)'],
    ['node_ws_trade_witnesses', 'FOREIGN KEY (trade_id) REFERENCES bybit_live.bybit_live_trades(trade_id)'],
  ];
  for (const [table, definition] of constraints) {
    if (!result.rows.some((row) => row.table_name === `bybit_live.${table}` && row.definition === definition))
      throw new Error(`Journal schema constraint mismatch: ${table}: ${definition}`);
  }
  const triggers = await pool.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='bybit_live' AND NOT t.tgisinternal
       AND t.tgenabled IN ('O','A') AND t.tgtype=27
       AND t.tgqual IS NULL AND t.tgnargs=0
       AND t.tgfoid=to_regprocedure('bybit_live.reject_mutation()')
       AND c.relname IN ('node_ws_messages','node_ws_trade_witnesses','node_ws_journal_frames')`);
  for (const table of ['node_ws_messages', 'node_ws_trade_witnesses', 'node_ws_journal_frames']) {
    if (!triggers.rows.some((row) => row.table_name === table))
      throw new Error(`Journal append-only trigger missing/disabled: ${table}`);
  }
  const columns = await pool.query<{ name: string; type: string; required: boolean }>(`
    SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
           a.attnotnull AS required
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=to_regclass('bybit_live.node_ws_journal_frames')
       AND a.attnum>0 AND NOT a.attisdropped`);
  const expected = { connection_id: 'uuid', message_ordinal: 'bigint', epoch_id: 'uuid',
    first_receive_order: 'bigint', trade_count: 'integer', min_timestamp: 'bigint',
    max_timestamp: 'bigint', witnesses: 'jsonb', committed_at: 'timestamp with time zone' };
  for (const [name, type] of Object.entries(expected)) {
    if (!columns.rows.some((row) => row.name === name && row.type === type && row.required))
      throw new Error(`Journal column contract mismatch: ${name}`);
  }
}
