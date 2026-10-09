-- DBA-reviewed, one-shot migration. Do not apply automatically or start services.
-- Must be run as the reviewed postgres administrator in one transaction so the
-- SECURITY DEFINER function is never visible with its default PUBLIC grant.
BEGIN;
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Migration 007 requires the reviewed postgres owner';
  END IF;
END
$$;

-- No PID or key arguments: callers can only ask whether the latest approved
-- live boundary's Producer session owns its one fixed writer lock. Failed
-- restart epoch rows remain append-only evidence, never the active boundary.
-- No session details
-- are returned. The owner can see producer backend_start without granting
-- pg_read_all_stats to bybit_shadow or any other application role.
CREATE FUNCTION bybit_live.producer_writer_session_verified()
RETURNS boolean
LANGUAGE sql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT session_user::text = 'bybit_shadow' AND EXISTS (
    SELECT 1
      FROM (SELECT epoch_id FROM bybit_live.node_live_epoch_boundaries
             ORDER BY recorded_at DESC, approval_id DESC LIMIT 1) b
      JOIN bybit_live.node_producer_epochs e ON e.epoch_id = b.epoch_id
      JOIN LATERAL (
        SELECT backend_pid, backend_start, state, at
          FROM bybit_live.node_producer_heartbeats
         WHERE epoch_id = e.epoch_id ORDER BY id DESC LIMIT 1
      ) h ON true
      JOIN pg_catalog.pg_stat_activity a
        ON a.pid = h.backend_pid
       AND a.backend_start = h.backend_start
       AND a.usename = 'bybit_producer'
       AND a.backend_type = 'client backend'
      JOIN pg_catalog.pg_locks l
        ON l.pid = a.pid AND l.database = a.datid
       AND l.locktype = 'advisory' AND l.granted
       AND l.mode = 'ExclusiveLock'
       AND l.classid = 73142::oid AND l.objid = 1001::oid AND l.objsubid = 2
     WHERE h.state = 'RUNNING'
       AND h.at <= pg_catalog.clock_timestamp()
       AND h.at > pg_catalog.clock_timestamp() - interval '3 seconds'
       AND a.datid = (SELECT oid FROM pg_catalog.pg_database
                       WHERE datname = pg_catalog.current_database())
  );
$function$;

ALTER FUNCTION bybit_live.producer_writer_session_verified() OWNER TO postgres;
REVOKE ALL ON FUNCTION bybit_live.producer_writer_session_verified() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bybit_live.producer_writer_session_verified() TO bybit_shadow;
COMMIT;
