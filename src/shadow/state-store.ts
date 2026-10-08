import type pg from 'pg';
import { FROZEN } from '../config/frozen.js';
import type { ShadowState } from './shadow-engine.js';

type JournalRow = {
  id: string;
  activation_id: string;
  idempotency_key: string;
  event_type: 'ACTIVATION' | 'TRANSITION';
  signal_ms: string | null;
  model_hash: string;
  feature_schema_hash: string;
  strategy_version: string;
  state_snapshot: unknown;
};

export interface RestoredShadow { activationId: string; lastSignalTimestamp: number | null; state: ShadowState; }

export function validateRestoredState(raw: unknown, activationAt?: number): ShadowState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Shadow snapshot');
  const value = raw as Partial<ShadowState>;
  if (!Number.isFinite(value.activationAt) || (activationAt !== undefined && value.activationAt !== activationAt) ||
      !Number.isFinite(value.balanceBtc) || !Number.isFinite(value.peakEquity) ||
      !Number.isFinite(value.mdd) || !Array.isArray(value.closed) ||
      !Array.isArray(value.processedSignals) || new Set(value.processedSignals).size !== value.processedSignals.length ||
      (value.open !== null && (typeof value.open !== 'object' || !value.open))) {
    throw new Error('Corrupt Shadow snapshot');
  }
  return value as ShadowState;
}

function validateRow(row: JournalRow): ShadowState {
  if (row.model_hash !== FROZEN.directionModelHash ||
      row.feature_schema_hash !== FROZEN.featureSchemaHash ||
      row.strategy_version !== FROZEN.strategyVersion) throw new Error('Frozen journal hash/version mismatch');
  return validateRestoredState(row.state_snapshot);
}

/** Database transaction is the sole commit point. The in-memory engine must be reloaded after any failed write. */
export class ShadowStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async restore(activationId: string): Promise<RestoredShadow | null> {
    const result = await this.pool.query<JournalRow>(
      `SELECT id::text, activation_id::text, idempotency_key, event_type,
              (extract(epoch FROM signal_timestamp)*1000)::bigint::text AS signal_ms,
              model_hash, feature_schema_hash, strategy_version, state_snapshot
         FROM shadow_trading_v1.node_shadow_journal
        WHERE activation_id=$1::uuid ORDER BY id DESC LIMIT 1`, [activationId]);
    const row = result.rows[0];
    return row ? { activationId: row.activation_id,
      lastSignalTimestamp: row.signal_ms === null ? null : Number(row.signal_ms),
      state: validateRow(row) } : null;
  }

  async activate(activationId: string, state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'> {
    return this.append(activationId, `activation:${activationId}`, 'ACTIVATION', null, state);
  }

  async persistTransition(activationId: string, signalId: string, signalTimestamp: number,
                          state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'> {
    if (!state.processedSignals.includes(signalId)) throw new Error('Signal not present in snapshot');
    return this.append(activationId, `signal:${signalId}`, 'TRANSITION', signalTimestamp, state);
  }

  private async append(activationId: string, key: string, eventType: 'ACTIVATION' | 'TRANSITION',
                       signalTimestamp: number | null, state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'> {
    validateRestoredState(state);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activationId]);
      const prior = await client.query<JournalRow>(
        `SELECT id::text, activation_id::text, idempotency_key, event_type,
                (extract(epoch FROM signal_timestamp)*1000)::bigint::text AS signal_ms,
                model_hash, feature_schema_hash, strategy_version, state_snapshot
           FROM shadow_trading_v1.node_shadow_journal
          WHERE activation_id=$1::uuid ORDER BY id DESC LIMIT 1`, [activationId]);
      const last = prior.rows[0];
      if (last) {
        const old = validateRow(last);
        if (old.activationAt !== state.activationAt) throw new Error('Activation boundary changed');
        if (eventType === 'ACTIVATION') { await client.query('COMMIT'); return 'DUPLICATE'; }
        const existingKey = await client.query<{ id: string }>(
          `SELECT id::text FROM shadow_trading_v1.node_shadow_journal
            WHERE idempotency_key=$1 LIMIT 1`, [key]);
        if (existingKey.rowCount) { await client.query('COMMIT'); return 'DUPLICATE'; }
        if (last.signal_ms !== null && signalTimestamp! <= Number(last.signal_ms)) {
          throw new Error('Nonmonotonic Shadow signal');
        }
      } else if (eventType !== 'ACTIVATION') throw new Error('Activation event missing');
      const result = await client.query(
        `INSERT INTO shadow_trading_v1.node_shadow_journal
          (activation_id,idempotency_key,event_type,signal_timestamp,event_timestamp,
           strategy_version,model_hash,feature_schema_hash,state_snapshot)
         VALUES ($1::uuid,$2,$3,
           CASE WHEN $4::double precision IS NULL THEN NULL ELSE to_timestamp($4::double precision/1000) END,
           clock_timestamp(),$5,$6,$7,$8::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [activationId,key,eventType,signalTimestamp,FROZEN.strategyVersion,
          FROZEN.directionModelHash,FROZEN.featureSchemaHash,JSON.stringify(state)]);
      await client.query('COMMIT');
      return result.rowCount ? 'COMMITTED' : 'DUPLICATE';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
