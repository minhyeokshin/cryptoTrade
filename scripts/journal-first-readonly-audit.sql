\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_user, session_user, current_database(), current_setting('transaction_read_only');
SELECT c.relname, has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
 has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
 has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
 has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
 has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='bybit_live' AND c.relname IN
 ('node_ws_messages','node_ws_trade_witnesses','node_ws_journal_frames');
SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
 pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
 FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d
 ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='bybit_live.node_ws_journal_frames'::regclass
 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum;
SELECT conrelid::regclass, conname, convalidated, condeferrable,
 pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
 WHERE conrelid IN ('bybit_live.node_ws_journal_frames'::regclass,
 'bybit_live.node_ws_trade_witnesses'::regclass);
SELECT tgrelid::regclass,tgname,tgenabled,pg_catalog.pg_get_triggerdef(oid)
 FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid IN
 ('bybit_live.node_ws_messages'::regclass,'bybit_live.node_ws_trade_witnesses'::regclass,
 'bybit_live.node_ws_journal_frames'::regclass);
SELECT count(*) AS journal_rows FROM bybit_live.node_ws_journal_frames;
SELECT count(*) AS missing_message_or_epoch
 FROM bybit_live.node_ws_journal_frames j
 LEFT JOIN bybit_live.node_ws_messages m USING(connection_id,message_ordinal)
 LEFT JOIN bybit_live.node_producer_epochs e USING(epoch_id)
 WHERE m.connection_id IS NULL OR e.epoch_id IS NULL;
SELECT epoch_id AS latest_attempt_epoch,epoch_start
 FROM bybit_live.node_producer_epochs ORDER BY epoch_start DESC LIMIT 1;
SELECT b.approval_id,b.epoch_id AS approved_boundary_epoch,b.gap_start,b.gap_end,
 b.first_complete_minute_start,b.historical_source_gap,
 e.epoch_id IS NOT NULL AS boundary_epoch_exists
 FROM bybit_live.node_live_epoch_boundaries b
 LEFT JOIN bybit_live.node_producer_epochs e USING(epoch_id)
 ORDER BY b.recorded_at DESC,b.approval_id DESC LIMIT 1;
ROLLBACK;
