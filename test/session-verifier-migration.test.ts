import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../src/db/migrations/007_producer_session_verifier.sql', import.meta.url),
  'utf8');

describe('Migration 007 least-privilege session verifier contract', () => {
  it('returns only boolean and exposes no caller-controlled PID or key', () => {
    expect(sql).toMatch(/CREATE FUNCTION bybit_live\.producer_writer_session_verified\(\)\s+RETURNS boolean/);
    expect(sql).toContain("session_user::text = 'bybit_shadow'");
    expect(sql).toContain("current_user <> 'postgres'");
  });

  it('binds the current DB, fixed key, producer role, PID and backend generation', () => {
    for (const predicate of [
      'l.database = a.datid',
      'a.pid = h.backend_pid',
      'a.backend_start = h.backend_start',
      "a.usename = 'bybit_producer'",
      "a.backend_type = 'client backend'",
      "l.locktype = 'advisory'",
      'l.granted',
      "l.mode = 'ExclusiveLock'",
      'l.classid = 73142::oid',
      'l.objid = 1001::oid',
      'l.objsubid = 2',
      'pg_catalog.current_database()',
      "h.state = 'RUNNING'",
      "interval '3 seconds'",
    ]) expect(sql).toContain(predicate);
  });

  it('fixes search_path and revokes PUBLIC before commit without broad stats grants', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain('OWNER TO postgres');
    expect(sql).toMatch(/BEGIN;[\s\S]*REVOKE ALL ON FUNCTION bybit_live\.producer_writer_session_verified\(\) FROM PUBLIC;[\s\S]*GRANT EXECUTE ON FUNCTION bybit_live\.producer_writer_session_verified\(\) TO bybit_shadow;[\s\S]*COMMIT;/);
    expect(sql).not.toMatch(/GRANT\s+pg_read_all_stats/i);
  });
});
