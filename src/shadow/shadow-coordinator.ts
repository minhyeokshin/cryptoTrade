import type { FrozenPrediction } from '../types/domain.js';
import { ShadowEngine, signalId, type ShadowState } from './shadow-engine.js';
import type { RestoredShadow } from './state-store.js';

export interface ShadowJournal {
  restore(activationId: string): Promise<RestoredShadow | null>;
  persistTransition(activationId: string, signalId: string, signalTimestamp: number,
                    state: ShadowState): Promise<'COMMITTED' | 'DUPLICATE'>;
}

export type ProcessOutcome = { status: string; entry: boolean; exit: boolean };

/** Serializes pure-engine transitions to an append-only journal before exposing the result. */
export class ShadowCoordinator {
  private engine: ShadowEngine;
  private processing = false;
  private halted = false;
  private constructor(private readonly journal: ShadowJournal, private readonly activationId: string,
                      private readonly activationAt: number, private readonly initialMark: number,
                      private readonly lotSize: number, restored: ShadowState) {
    this.engine = new ShadowEngine(activationAt, initialMark, lotSize, restored);
  }

  static async resume(journal: ShadowJournal, activationId: string, activationAt: number,
                      initialMark: number, lotSize: number): Promise<ShadowCoordinator> {
    const restored = await journal.restore(activationId);
    if (!restored || restored.state.activationAt !== activationAt) throw new Error('Verified activation state missing');
    return new ShadowCoordinator(journal, activationId, activationAt, initialMark, lotSize, restored.state);
  }

  snapshot(): ShadowState { return structuredClone(this.engine.state); }

  async process(prediction: FrozenPrediction, executionAt: number, rawPrice: number, mark: number,
                sourceFresh: boolean): Promise<ProcessOutcome> {
    if (this.halted) throw new Error('Shadow coordinator halted after failed restore');
    if (this.processing) throw new Error('Concurrent Shadow transition forbidden');
    this.processing = true;
    try {
      const outcome = this.engine.consume(prediction, executionAt, rawPrice, mark, sourceFresh);
      if (outcome.status === 'SOURCE_BLOCKED' || outcome.status === 'PRE_ACTIVATION' ||
          outcome.status === 'DUPLICATE') return { status: outcome.status, entry: false, exit: false };
      const saved = await this.journal.persistTransition(this.activationId, signalId(prediction),
        prediction.decisionTimestamp, this.engine.state);
      if (saved === 'DUPLICATE') {
        await this.reload();
        return { status: 'DUPLICATE', entry: false, exit: false };
      }
      return { status: outcome.status, entry: outcome.entry !== null, exit: outcome.exit !== null };
    } catch (error) {
      try { await this.reload(); }
      catch { this.halted = true; }
      throw error;
    } finally { this.processing = false; }
  }

  private async reload(): Promise<void> {
    const restored = await this.journal.restore(this.activationId);
    if (!restored || restored.state.activationAt !== this.activationAt) throw new Error('Cannot restore committed Shadow state');
    this.engine = new ShadowEngine(this.activationAt, this.initialMark, this.lotSize, restored.state);
  }
}
