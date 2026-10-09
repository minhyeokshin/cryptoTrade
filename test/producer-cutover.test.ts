import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { validateCutoverEvidence, type CutoverEvidence } from '../src/market/producer-cutover-guard.js';
import { ProducerLease } from '../src/db/producer-lease.js';
import { bindProducerEpoch } from '../src/db/producer-startup.js';

function approved(): CutoverEvidence {
  return { osUser: 'bybit_producer', approvalRootOwned: true,
    approvalNotGroupOrWorldWritable: true,
    approval: { policy: 'NODE_CANONICAL_WRITER_CUTOVER', approved_by_human: true,
      node_writer_authorized: true, python_service: 'bybit-producer.service',
      approved_at: '2026-10-08T00:00:00Z' },
    serviceActive: 'inactive', serviceEnabled: 'disabled', serviceMainPid: '0',
    legacyProcessFound: false };
}

describe('single-writer cutover guard', () => {
  it('requires both human approval and conclusive Python service shutdown', () => {
    expect(() => validateCutoverEvidence(approved())).not.toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), serviceActive: 'active' })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), serviceEnabled: 'enabled' })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), legacyProcessFound: true })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), serviceMainPid: '1234' })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), osUser: 'minhyeok' })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), approvalRootOwned: false })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), approvalNotGroupOrWorldWritable: false })).toThrow();
    expect(() => validateCutoverEvidence({ ...approved(), approval: {
      ...(approved().approval as object), node_writer_authorized: false } })).toThrow();
  });

  it('holds and releases an exclusive PostgreSQL advisory lock on one peer session', async () => {
    const queries: string[] = [];
    let released = 0;
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('current_user')) return { rows: [{ current_user: 'bybit_producer',
        session_user: 'bybit_producer' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [{ pg_advisory_unlock: true }] };
    }, release: () => { released++; } };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const lease = await ProducerLease.acquire(pool);
    expect(lease.client).toBe(client);
    await lease.startEpoch('11111111-1111-4111-8111-111111111111', '0.1.0');
    expect(queries.some((sql) => sql.includes('node_producer_epochs'))).toBe(true);
    expect(queries.some((sql) => sql.includes('operational_health_events'))).toBe(true);
    await lease.release();
    await lease.release();
    expect(queries.filter((sql) => sql.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(released).toBe(1);
  });

  it('rejects a competing Node writer without retaining its session', async () => {
    let released = 0;
    const client = { query: async (sql: string) => sql.includes('current_user')
      ? { rows: [{ current_user: 'bybit_producer', session_user: 'bybit_producer' }] }
      : { rows: [{ acquired: false }] }, release: () => { released++; } };
    await expect(ProducerLease.acquire({ connect: async () => client } as unknown as pg.Pool))
      .rejects.toThrow('Another Node canonical writer');
    expect(released).toBe(1);
  });

  it('writes heartbeat only from the lock-owning backend and its session generation', async () => {
    const queries: string[] = [];
    let ownsLock = true;
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('current_user')) return { rows: [{ current_user: 'bybit_producer',
        session_user: 'bybit_producer' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('node_producer_heartbeats')) return { rowCount: ownsLock ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    }, release: () => {} };
    const pool = { connect: async () => client, query: async () => {
      throw new Error('Heartbeat must not use pool query');
    } } as unknown as pg.Pool;
    const lease = await ProducerLease.acquire(pool);
    await lease.startEpoch('11111111-1111-4111-8111-111111111111', '0.1.0');
    await lease.heartbeat('RUNNING');
    const heartbeatSql = queries.find((sql) => sql.includes('node_producer_heartbeats'))!;
    expect(heartbeatSql).toContain('a.backend_start');
    expect(heartbeatSql).toContain('a.pid=pg_backend_pid()');
    expect(heartbeatSql).toContain('l.database=a.datid');
    expect(heartbeatSql).toContain("l.locktype='advisory'");
    expect(heartbeatSql).toContain('l.granted');
    ownsLock = false;
    await expect(lease.heartbeat('RUNNING')).rejects.toThrow('no longer owns writer lock');
    await lease.release();
  });

  it('resumes only the approved boundary after a failed later epoch without inserting a new one', async () => {
    const boundaryEpoch = 'dff8316a-f21d-4093-9b97-98100e706dee';
    const approvalId = '10000000-0000-4000-8000-000000000001';
    const queries: string[] = [];
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('current_user')) return { rows: [{ current_user: 'bybit_producer',
        session_user: 'bybit_producer' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT b.epoch_id')) return { rows: [{ epoch_id: boundaryEpoch,
        approval_id: approvalId }] };
      if (sql.includes('node_producer_heartbeats')) return { rowCount: 1 };
      return { rows: [] };
    }, release: () => {} };
    const lease = await ProducerLease.acquire({ connect: async () => client } as unknown as pg.Pool);
    expect(await bindProducerEpoch(lease, 'WRITE', approvalId)).toBe(boundaryEpoch);
    await lease.heartbeat('RUNNING');
    expect(queries.some((sql) => sql.includes('INSERT INTO bybit_live.node_producer_epochs'))).toBe(false);
    expect(queries.some((sql) => sql.includes('JOIN bybit_live.node_producer_epochs e'))).toBe(true);
    await lease.release();
  });

  it('rejects an old approval on restart and creates a row only for a fresh approval', async () => {
    const latestApproval = '10000000-0000-4000-8000-000000000002';
    const client = { query: async (sql: string) => {
      if (sql.includes('current_user')) return { rows: [{ current_user: 'bybit_producer',
        session_user: 'bybit_producer' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('SELECT b.epoch_id')) return { rows: [{ epoch_id: 'dff8316a-f21d-4093-9b97-98100e706dee',
        approval_id: latestApproval }] };
      return { rows: [] };
    }, release: () => {} };
    const lease = await ProducerLease.acquire({ connect: async () => client } as unknown as pg.Pool);
    await expect(bindProducerEpoch(lease, 'WRITE', '10000000-0000-4000-8000-000000000001'))
      .rejects.toThrow('approval mismatch');
    await lease.release();
    let started = 0;
    const fresh = { startEpoch: async () => { started++; },
      resumeApprovedEpoch: async () => { throw new Error('must not resume'); } };
    await expect(bindProducerEpoch(fresh, 'NEW_LIVE_EPOCH')).rejects.toThrow('human approval');
    expect(await bindProducerEpoch(fresh, 'NEW_LIVE_EPOCH', latestApproval,
      () => '7ed1eed8-096b-4007-a642-ec4f34271cf1'))
      .toBe('7ed1eed8-096b-4007-a642-ec4f34271cf1');
    expect(started).toBe(1);
  });
});
