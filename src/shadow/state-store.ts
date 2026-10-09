import type pg from 'pg';
import { FROZEN } from '../config/frozen.js';
import { executionPrice } from './inverse-pnl.js';
import type { ClosedPosition, Position, ShadowState } from './shadow-engine.js';

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

function finitePositive(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function finite(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value); }
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1e-10, Math.abs(expected) * 1e-10);
}
function validPosition(value: unknown, activationAt: number): value is Position {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Position>;
  return typeof p.signalId === 'string' &&
    (p.side === 'LONG' || p.side === 'SHORT') &&
    Number.isSafeInteger(p.signalTimestamp) && p.signalTimestamp! >= activationAt &&
    p.signalId === `${FROZEN.strategyVersion}:BTCUSD:${p.signalTimestamp}` &&
    Number.isSafeInteger(p.entryAt) && p.entryAt! > p.signalTimestamp! &&
    finite(p.confidence) && p.confidence! >= FROZEN.threshold && p.confidence! <= 1 &&
    finitePositive(p.rawEntry) && finitePositive(p.executionEntry) &&
    Number.isSafeInteger(p.contracts) && p.contracts! > 0 &&
    finitePositive(p.equityBefore) && finitePositive(p.marginUsd) && finitePositive(p.notionalUsd) &&
    near(p.executionEntry!, executionPrice(p.rawEntry!, p.side, true)) &&
    near(p.marginUsd!, p.equityBefore! * FROZEN.allocationRate) &&
    near(p.notionalUsd!, p.marginUsd! * FROZEN.leverage) &&
    p.contracts! <= p.notionalUsd! &&
    finite(p.mfeBtc) && p.mfeBtc! >= 0 && finite(p.maeBtc) && p.maeBtc! <= 0;
}

function validClosed(value: unknown, activationAt: number): value is ClosedPosition {
  if (!validPosition(value, activationAt)) return false;
  const p = value as ClosedPosition;
  return Number.isSafeInteger(p.exitAt) && p.exitAt > p.entryAt &&
    (p.exitReason === 'DIRECTION_FLIP' || p.exitReason === 'HORIZON') &&
    finitePositive(p.rawExit) && finitePositive(p.executionExit) &&
    near(p.executionExit, executionPrice(p.rawExit, p.side, false)) &&
    finite(p.grossBtc) && finite(p.netBtc) && finite(p.netUsd) &&
    finite(p.feesBtc) && p.feesBtc >= 0 && finite(p.slippageBtc) && p.slippageBtc >= 0 &&
    near(p.netBtc, p.grossBtc - p.slippageBtc - p.feesBtc) &&
    near(p.netUsd, p.netBtc * p.executionExit) &&
    finitePositive(p.equityAfter) && finitePositive(p.peakEquity) &&
    finite(p.drawdownPct) && p.drawdownPct >= 0 && p.drawdownPct <= 1;
}

export function validateRestoredState(raw: unknown, activationAt?: number): ShadowState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Shadow snapshot');
  const value = raw as Partial<ShadowState>;
  if (!Number.isSafeInteger(value.activationAt) || value.activationAt! < 0 ||
      (activationAt !== undefined && value.activationAt !== activationAt) ||
      !finitePositive(value.balanceBtc) || !finitePositive(value.peakEquity) ||
      !finite(value.mdd) || value.mdd! < 0 || value.mdd! > 1 ||
      !Array.isArray(value.closed) || !Array.isArray(value.processedSignals) ||
      !value.processedSignals.every((id) => {
        if (typeof id !== 'string') return false;
        const prefix = `${FROZEN.strategyVersion}:BTCUSD:`;
        const suffix = id.slice(prefix.length);
        return id.startsWith(prefix) && /^\d+$/.test(suffix) &&
          Number.isSafeInteger(Number(suffix)) && Number(suffix) >= value.activationAt!;
      }) ||
      new Set(value.processedSignals).size !== value.processedSignals.length ||
      !value.processedSignals.every((id, i) => i === 0 ||
        Number(id.split(':').at(-1)) > Number(value.processedSignals![i - 1]!.split(':').at(-1))) ||
      !value.closed.every((p) => validClosed(p, value.activationAt!)) ||
      !value.closed.every((p, i) => i === 0 || p.exitAt >= value.closed![i - 1]!.exitAt) ||
      (value.open !== null && !validPosition(value.open, value.activationAt!)) ||
      (value.open !== null && value.closed.length > 0 &&
        value.open!.entryAt < value.closed.at(-1)!.exitAt) ||
      (value.open !== null && !value.processedSignals.includes(value.open!.signalId)) ||
      value.closed.some((p) => !value.processedSignals!.includes(p.signalId))) {
    throw new Error('Corrupt Shadow snapshot');
  }
  return value as ShadowState;
}

function validateRow(row: JournalRow): ShadowState {
  if (row.model_hash !== FROZEN.directionModelHash ||
      row.feature_schema_hash !== FROZEN.featureSchemaHash ||
      row.strategy_version !== FROZEN.strategyVersion) throw new Error('Frozen journal hash/version mismatch');
  const state = validateRestoredState(row.state_snapshot);
  if (row.event_type === 'ACTIVATION') {
    if (row.signal_ms !== null || row.idempotency_key !== `activation:${row.activation_id}` ||
        state.processedSignals.length || state.open || state.closed.length) {
      throw new Error('Corrupt Shadow activation journal');
    }
  } else if (row.event_type === 'TRANSITION') {
    const last = state.processedSignals.at(-1);
    if (!last || row.idempotency_key !== `signal:${last}` ||
        !Number.isSafeInteger(Number(row.signal_ms)) ||
        Number(last.split(':').at(-1)) !== Number(row.signal_ms)) {
      throw new Error('Corrupt Shadow transition journal');
    }
  } else throw new Error('Unknown Shadow journal event');
  return state;
}

/** Database transaction is the sole commit point. The in-memory engine must be reloaded after any failed write. */
export class ShadowStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async isSuspended(activationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM shadow_trading_v1.node_shadow_suspensions
        WHERE activation_id=$1::uuid LIMIT 1`, [activationId]);
    return result.rowCount === 1;
  }

  async hasUnresolvedOpenSuspension(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM shadow_trading_v1.node_shadow_suspensions
        WHERE open_position IS NOT NULL
       UNION ALL
       SELECT 1 FROM (
         SELECT DISTINCT ON (activation_id) state_snapshot
           FROM shadow_trading_v1.node_shadow_journal
          ORDER BY activation_id,id DESC
       ) latest WHERE latest.state_snapshot->'open' <> 'null'::jsonb
       LIMIT 1`);
    return result.rowCount === 1;
  }

  async suspend(activationId: string, producerEpochId: string,
    openPosition: Position | null, reason: string): Promise<void> {
    const position = openPosition ? JSON.stringify(openPosition) : null;
    const recordedReason = reason.slice(0, 300);
    const inserted = await this.pool.query(
      `INSERT INTO shadow_trading_v1.node_shadow_suspensions
         (activation_id,producer_epoch_id,open_position,reason)
       VALUES ($1::uuid,$2::uuid,$3::jsonb,$4)
       ON CONFLICT (activation_id) DO NOTHING RETURNING activation_id`,
      [activationId, producerEpochId, position, recordedReason]);
    if (inserted.rowCount === 1) return;
    const existing = await this.pool.query<{ identical: boolean }>(
      `SELECT (producer_epoch_id=$2::uuid AND
               open_position IS NOT DISTINCT FROM $3::jsonb AND reason=$4) AS identical
         FROM shadow_trading_v1.node_shadow_suspensions WHERE activation_id=$1::uuid`,
      [activationId, producerEpochId, position, recordedReason]);
    if (existing.rowCount !== 1 || existing.rows[0]?.identical !== true) {
      throw new Error('Conflicting Shadow suspension for activation');
    }
  }

  async restore(activationId: string): Promise<RestoredShadow | null> {
    const result = await this.pool.query<JournalRow>(
      `SELECT id::text, activation_id::text, idempotency_key, event_type,
              (extract(epoch FROM signal_timestamp)*1000)::bigint::text AS signal_ms,
              model_hash, feature_schema_hash, strategy_version, state_snapshot
         FROM shadow_trading_v1.node_shadow_journal
        WHERE activation_id=$1::uuid ORDER BY id DESC LIMIT 1`, [activationId]);
    const row = result.rows[0];
    if (row && row.activation_id !== activationId) throw new Error('Shadow activation ID mismatch');
    return row ? { activationId: row.activation_id,
      lastSignalTimestamp: row.signal_ms === null ? null : Number(row.signal_ms),
      state: validateRow(row) } : null;
  }

  async activate(activationId: string, state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'> {
    return this.append(activationId, `activation:${activationId}`, 'ACTIVATION', null, state);
  }

  async persistTransition(activationId: string, signalId: string, signalTimestamp: number,
                          state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'> {
    if (state.processedSignals.at(-1) !== signalId ||
        signalId !== `${FROZEN.strategyVersion}:BTCUSD:${signalTimestamp}`) {
      throw new Error('Signal/timestamp not latest in snapshot');
    }
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
