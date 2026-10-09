export function journalCatalog(sql: string) {
  if (sql.includes('pg_constraint')) return [
    ['node_ws_journal_frames', 'PRIMARY KEY (connection_id, message_ordinal)'],
    ['node_ws_journal_frames', 'FOREIGN KEY (epoch_id) REFERENCES bybit_live.node_producer_epochs(epoch_id)'],
    ['node_ws_journal_frames', 'FOREIGN KEY (connection_id, message_ordinal) REFERENCES bybit_live.node_ws_messages(connection_id, message_ordinal)'],
    ['node_ws_trade_witnesses', 'FOREIGN KEY (trade_id) REFERENCES bybit_live.bybit_live_trades(trade_id)'],
  ].map(([table, definition]) => ({ table_name: `bybit_live.${table}`, definition }));
  if (sql.includes('pg_trigger')) return ['node_ws_messages', 'node_ws_trade_witnesses',
    'node_ws_journal_frames'].map((table_name) => ({ table_name }));
  if (sql.includes('pg_attribute')) return Object.entries({ connection_id: 'uuid',
    message_ordinal: 'bigint', epoch_id: 'uuid', first_receive_order: 'bigint', trade_count: 'integer',
    min_timestamp: 'bigint', max_timestamp: 'bigint', witnesses: 'jsonb',
    committed_at: 'timestamp with time zone' }).map(([name, type]) => ({ name, type, required: true }));
  return null;
}
