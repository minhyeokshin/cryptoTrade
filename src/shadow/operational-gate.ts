import { readFileSync, statSync } from 'node:fs';

export const SHADOW_OPERATIONAL_GATE_PATH = '/etc/cryptoTrade/shadow_operational_gate.json';
const required = ['single_writer', 'producer_restart_safety', 'current_live_stream_continuity',
  'source_freshness', 'model_parity', 'causal_inference', 'shadow_db', 'idempotency'] as const;

export function validateShadowOperationalGate(raw: unknown, activationId: string,
  producerEpochId: string, now: number): void {
  if (!raw || typeof raw !== 'object') throw new Error('Shadow operational gate missing');
  const gate = raw as Record<string, unknown>;
  const approvedAt = typeof gate.approved_at === 'string' ? Date.parse(gate.approved_at) : NaN;
  if (gate.approved_by_human !== true || gate.activation_id !== activationId ||
      gate.producer_epoch_id !== producerEpochId ||
      !Number.isFinite(approvedAt) || approvedAt > now || now - approvedAt > 3_600_000 ||
      gate.actual_orders !== 0 || gate.private_api_calls !== 0 ||
      required.some((key) => gate[key] !== 'PASS')) {
    throw new Error('Shadow operational gate is not fully verified for this activation/epoch');
  }
}

/** Root-owned external attestation; never stored in the repository or generated from test fixtures. */
export function readShadowOperationalGate(): unknown {
  const stat = statSync(SHADOW_OPERATIONAL_GATE_PATH);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Shadow operational gate must be root-owned and not group/world writable');
  }
  return JSON.parse(readFileSync(SHADOW_OPERATIONAL_GATE_PATH, 'utf8')) as unknown;
}
