import { readFileSync, statSync } from 'node:fs';

export const NEW_EPOCH_APPROVAL_PATH = '/etc/cryptoTrade/node_new_live_epoch_approval.json';
export interface NewEpochApproval {
  approval_id: string;
  previous_approval_id: string;
  approved_by_human: true;
  approved_at: string;
  expected_gap_start: string;
  historical_gap_may_remain_open: true;
  new_live_epoch_authorized: true;
  /** Informational only for this producer approval; Shadow has a separate gate. */
  forward_shadow_may_start_after_new_epoch_health_pass: boolean;
  actual_orders_allowed: false;
  private_api_allowed: false;
}

export function validateNewEpochApproval(input: unknown): NewEpochApproval {
  if (!input || typeof input !== 'object') throw new Error('New live epoch approval missing');
  const x = input as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (x.policy !== 'NODE_CURRENT_LIVE_EPOCH' ||
      typeof x.approval_id !== 'string' ||
      !uuid.test(x.approval_id) ||
      typeof x.previous_approval_id !== 'string' ||
      !uuid.test(x.previous_approval_id) ||
      x.approval_id === x.previous_approval_id ||
      x.approved_by_human !== true ||
      typeof x.approved_at !== 'string' ||
      !Number.isFinite(Date.parse(x.approved_at)) ||
      typeof x.expected_gap_start !== 'string' ||
      !Number.isFinite(Date.parse(x.expected_gap_start)) ||
      x.historical_gap_may_remain_open !== true ||
      x.new_live_epoch_authorized !== true ||
      typeof x.forward_shadow_may_start_after_new_epoch_health_pass !== 'boolean' ||
      x.actual_orders_allowed !== false || x.private_api_allowed !== false) {
    throw new Error('New live epoch approval invalid');
  }
  return x as unknown as NewEpochApproval;
}

export function loadNewEpochApproval(): NewEpochApproval {
  const stat = statSync(NEW_EPOCH_APPROVAL_PATH);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('New epoch approval must be root-owned and immutable to service user');
  return validateNewEpochApproval(JSON.parse(readFileSync(NEW_EPOCH_APPROVAL_PATH, 'utf8')) as unknown);
}

/** An already-used approval can only resume by strict persisted-anchor reconciliation. */
export function approvedStartupMode(approvalUsed: boolean): 'NEW_LIVE_EPOCH' | 'WRITE' {
  return approvalUsed ? 'WRITE' : 'NEW_LIVE_EPOCH';
}
