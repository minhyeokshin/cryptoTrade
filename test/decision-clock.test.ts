import { describe, expect, it } from 'vitest';
import { minuteDecision } from '../src/inference/decision-clock.js';

describe('frozen causal minute clock', () => {
  it('enters only on the UTC 5m grid and monitors a held position at t+1..t+4', () => {
    expect(minuteDecision(240_000, 300_000, null)).toBe('NO_INFERENCE');
    expect(minuteDecision(300_000, 300_000, null)).toBe('ENTRY_DECISION');
    for (let k = 1; k <= 4; k++) {
      expect(minuteDecision(300_000 + k * 60_000, 0, 300_000)).toBe('FLIP_MONITOR');
    }
    expect(minuteDecision(600_000, 0, 300_000)).toBe('HORIZON_AND_ENTRY_DECISION');
    expect(minuteDecision(360_000, 0, null)).toBe('NO_INFERENCE');
  });
  it('fails closed if the 5m horizon was missed', () => {
    expect(() => minuteDecision(660_000, 0, 300_000)).toThrow('Missed frozen horizon');
  });
});
