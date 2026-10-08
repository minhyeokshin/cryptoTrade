import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { validateShadowOperationalGate } from '../src/shadow/operational-gate.js';
import { ShadowRunLease } from '../src/db/shadow-run-lease.js';

const activationId = '11111111-1111-4111-8111-111111111111';
const epochId = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-10-08T06:00:00Z');
const gate = { approved_by_human: true, activation_id: activationId,
  producer_epoch_id: epochId, approved_at: '2026-10-08T05:55:00Z',
  actual_orders: 0, private_api_calls: 0,
  single_writer: 'PASS', producer_restart_safety: 'PASS',
  current_live_stream_continuity: 'PASS', source_freshness: 'PASS',
  model_parity: 'PASS', causal_inference: 'PASS', shadow_db: 'PASS', idempotency: 'PASS' };

describe('Shadow operational activation guard', () => {
  it('requires recent exact per-activation/per-producer-epoch evidence', () => {
    expect(() => validateShadowOperationalGate(gate, activationId, epochId, now)).not.toThrow();
    expect(() => validateShadowOperationalGate({ ...gate, producer_epoch_id: 'other' },
      activationId, epochId, now)).toThrow();
    expect(() => validateShadowOperationalGate({ ...gate, causal_inference: 'NOT_RUN' },
      activationId, epochId, now)).toThrow();
    expect(() => validateShadowOperationalGate({ ...gate, approved_at: '2026-10-08T04:00:00Z' },
      activationId, epochId, now)).toThrow();
  });
  it('allows only one Shadow engine lock holder', async () => {
    let releases = 0;
    const client = { query: async (sql: string) => sql.includes('current_user')
      ? { rows: [{ current_user: 'bybit_shadow', session_user: 'bybit_shadow' }] }
      : { rows: [{ acquired: true }] }, release: () => { releases++; } };
    const lease = await ShadowRunLease.acquire({ connect: async () => client } as unknown as pg.Pool);
    await lease.release();
    expect(releases).toBe(1);
  });
});
