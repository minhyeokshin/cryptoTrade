import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

export const CUTOVER_APPROVAL_PATH = '/etc/cryptoTrade/node_writer_cutover.json';
const LEGACY_PRODUCER = '/opt/btcMarketData-runtime/scripts/bybit_live/blind_capture_daemon.py';

export interface CutoverEvidence {
  osUser: string;
  approvalRootOwned: boolean;
  approvalNotGroupOrWorldWritable: boolean;
  approval: unknown;
  serviceActive: string;
  serviceEnabled: string;
  serviceMainPid: string;
  legacyProcessFound: boolean;
}

/** Fail closed unless the administrator has disabled and stopped the Python writer. */
export function validateCutoverEvidence(e: CutoverEvidence): void {
  if (!e.approval || typeof e.approval !== 'object') throw new Error('Node writer approval missing');
  const approval = e.approval as Record<string, unknown>;
  if (e.osUser !== 'bybit_producer' || !e.approvalRootOwned ||
      !e.approvalNotGroupOrWorldWritable ||
      approval.policy !== 'NODE_CANONICAL_WRITER_CUTOVER' ||
      approval.approved_by_human !== true || approval.node_writer_authorized !== true ||
      approval.python_service !== 'bybit-producer.service' ||
      typeof approval.approved_at !== 'string' || !Number.isFinite(Date.parse(approval.approved_at)) ||
      e.serviceActive !== 'inactive' || e.serviceEnabled !== 'disabled' ||
      e.serviceMainPid !== '0' || e.legacyProcessFound) {
    throw new Error('Python producer not conclusively stopped/disabled or Node writer not approved');
  }
}

function systemctl(...args: string[]): string {
  const result = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 5000 });
  if (result.error || !result.stdout?.trim()) throw new Error('Cannot verify Python service state');
  return result.stdout.trim();
}

/** Read-only OS checks; called at startup and before every canonical write. */
export function assertProducerCutover(): void {
  const approvalStat = statSync(CUTOVER_APPROVAL_PATH);
  const approval = JSON.parse(readFileSync(CUTOVER_APPROVAL_PATH, 'utf8')) as unknown;
  const processCheck = spawnSync('pgrep', ['-f', LEGACY_PRODUCER],
    { encoding: 'utf8', timeout: 5000 });
  if (processCheck.error || (processCheck.status !== 0 && processCheck.status !== 1)) {
    throw new Error('Cannot verify legacy producer process absence');
  }
  validateCutoverEvidence({ osUser: userInfo().username,
    approvalRootOwned: approvalStat.uid === 0,
    approvalNotGroupOrWorldWritable: (approvalStat.mode & 0o022) === 0,
    approval, serviceActive: systemctl('is-active', 'bybit-producer.service'),
    serviceEnabled: systemctl('is-enabled', 'bybit-producer.service'),
    serviceMainPid: systemctl('show', '-p', 'MainPID', '--value', 'bybit-producer.service'),
    legacyProcessFound: processCheck.status === 0 });
}
