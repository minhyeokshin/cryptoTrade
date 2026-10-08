import { FROZEN } from '../config/frozen.js';

export type MinuteDecision = 'NO_INFERENCE' | 'ENTRY_DECISION' | 'FLIP_MONITOR' | 'HORIZON_AND_ENTRY_DECISION';

/** Frozen 5m entry grid; off-grid 1m inference exists only while monitoring an open position. */
export function minuteDecision(candleEnd: number, activationAt: number,
                               openSignalTimestamp: number | null): MinuteDecision {
  if (candleEnd % 60_000 !== 0 || !Number.isFinite(candleEnd)) throw new Error('Invalid finalized minute');
  if (candleEnd < activationAt) return 'NO_INFERENCE';
  const onGrid = candleEnd % FROZEN.horizonMs === 0;
  if (openSignalTimestamp === null) return onGrid ? 'ENTRY_DECISION' : 'NO_INFERENCE';
  if (openSignalTimestamp % FROZEN.horizonMs !== 0 || candleEnd <= openSignalTimestamp) {
    throw new Error('Invalid open-position decision clock');
  }
  const elapsed = candleEnd - openSignalTimestamp;
  if (elapsed >= FROZEN.horizonMs) {
    if (elapsed !== FROZEN.horizonMs || !onGrid) throw new Error('Missed frozen horizon');
    return 'HORIZON_AND_ENTRY_DECISION';
  }
  return 'FLIP_MONITOR';
}
