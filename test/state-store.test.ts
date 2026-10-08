import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { FROZEN } from '../src/config/frozen.js';
import { ShadowEngine } from '../src/shadow/shadow-engine.js';
import { ShadowStateStore, validateRestoredState } from '../src/shadow/state-store.js';

const activationId = '00000000-0000-4000-8000-000000000001';

function fakePool(): pg.Pool {
  type Row = { id: string; activation_id: string; idempotency_key: string;
    event_type: 'ACTIVATION' | 'TRANSITION'; signal_ms: string | null;
    model_hash: string; feature_schema_hash: string; strategy_version: string;
    state_snapshot: unknown };
  const rows: Row[] = [];
  const client = { release: () => {}, query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO shadow_trading_v1.node_shadow_journal')) {
      const [id, key, kind, timestamp, version, model, feature, snapshot] = params;
      if (rows.some((row) => row.idempotency_key === key)) return { rowCount: 0, rows: [] };
      rows.push({ id: String(rows.length + 1), activation_id: String(id), idempotency_key: String(key),
        event_type: kind as Row['event_type'], signal_ms: timestamp === null ? null : String(timestamp),
        strategy_version: String(version), model_hash: String(model),
        feature_schema_hash: String(feature), state_snapshot: JSON.parse(String(snapshot)) });
      return { rowCount: 1, rows: [{ id: rows.length }] };
    }
    if (sql.includes('WHERE idempotency_key=$1')) {
      const found = rows.filter((row) => row.idempotency_key === params[0]);
      return { rowCount: found.length, rows: found.map((row) => ({ id: row.id })) };
    }
    if (sql.includes('WHERE activation_id=$1::uuid')) {
      const found = rows.filter((row) => row.activation_id === params[0]).at(-1);
      return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
    }
    return { rowCount: 0, rows: [] };
  } };
  return { connect: async () => client, query: client.query } as unknown as pg.Pool;
}

describe('append-only Shadow journal restart contract', () => {
  it('restores activation/open position and rejects re-read signal', async () => {
    const pool = fakePool();
    const store = new ShadowStateStore(pool);
    const engine = new ShadowEngine(0, 100, 1);
    expect(await store.activate(activationId, engine.state)).toBe('COMMITTED');
    const p = { decisionTimestamp: 300_000, featureCutoff: 300_000,
      side: 'LONG' as const, confidence: .6, actionable: true, flipActionable: true,
      modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash };
    const result = engine.consume(p, 300_001, 100, 100, true);
    expect(result.entry?.contracts).toBe(36);
    expect(await store.persistTransition(activationId, result.entry!.signalId, 300_000, engine.state)).toBe('COMMITTED');
    const recovered = await new ShadowStateStore(pool).restore(activationId);
    expect(recovered?.state.open?.contracts).toBe(36);
    expect(recovered?.lastSignalTimestamp).toBe(300_000);
    const restarted = new ShadowEngine(0, 100, 1, recovered!.state);
    expect(restarted.consume(p, 300_001, 100, 100, true).status).toBe('DUPLICATE');
    expect(await store.persistTransition(activationId, result.entry!.signalId, 300_000, engine.state)).toBe('DUPLICATE');
  });
  it('rejects tampered position sizing, execution, and closed PnL on restore', () => {
    const engine = new ShadowEngine(0, 100, 1);
    const p = { decisionTimestamp: 300_000, featureCutoff: 300_000,
      side: 'LONG' as const, confidence: .6, actionable: true, flipActionable: true,
      modelHash: FROZEN.directionModelHash, featureSchemaHash: FROZEN.featureSchemaHash };
    engine.consume(p, 300_001, 100, 100, true);
    expect(validateRestoredState(engine.state, 0).open?.contracts).toBe(36);
    expect(() => validateRestoredState({ ...engine.state,
      open: { ...engine.state.open!, marginUsd: 25 } })).toThrow('Corrupt');
    expect(() => validateRestoredState({ ...engine.state,
      open: { ...engine.state.open!, executionEntry: 100 } })).toThrow('Corrupt');
    expect(() => validateRestoredState({ ...engine.state,
      processedSignals: ['frozen-direction-5m-flip-v1:BTCUSD:'] })).toThrow('Corrupt');

    engine.consume({ ...p, decisionTimestamp: 600_000, featureCutoff: 600_000,
      side: 'NO_ACTION', confidence: 0, actionable: false, flipActionable: false },
    600_001, 110, 110, true);
    expect(validateRestoredState(engine.state, 0).closed).toHaveLength(1);
    const corrupt = structuredClone(engine.state);
    corrupt.closed[0]!.netUsd += 1;
    expect(() => validateRestoredState(corrupt)).toThrow('Corrupt');
  });
});
