import { randomUUID } from 'node:crypto';
import type { ProducerLease } from './producer-lease.js';

type StartupLease = Pick<ProducerLease, 'startEpoch' | 'resumeApprovedEpoch'>;

/** New approval creates an epoch; ordinary restart reuses its approved boundary. */
export async function bindProducerEpoch(lease: StartupLease,
  mode: 'WRITE' | 'NEW_LIVE_EPOCH', approvalId?: string,
  newId: () => string = randomUUID): Promise<string> {
  if (mode === 'WRITE') return lease.resumeApprovedEpoch(approvalId);
  if (!approvalId) throw new Error('New live epoch requires an unused human approval');
  const epochId = newId();
  await lease.startEpoch(epochId, '0.1.0');
  return epochId;
}
