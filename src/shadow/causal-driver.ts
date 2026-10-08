import type { CanonicalCandle, CanonicalTrade, FrozenPrediction } from '../types/domain.js';
import { FROZEN } from '../config/frozen.js';
import { assertCausalCandles } from '../inference/feature-builder.js';
import { minuteDecision } from '../inference/decision-clock.js';
import type { ProcessOutcome } from './shadow-coordinator.js';
import type { ShadowState } from './shadow-engine.js';

const MINUTE = 60_000;
const FROZEN_WARMUP_MINUTES = 12_000; // Python feature_producer.warmup_dependency()

export interface CausalPredictor {
  predict(candles: CanonicalCandle[], decisionTimestamp: number): Promise<FrozenPrediction>;
}
export interface CausalShadowSink {
  snapshot(): ShadowState;
  process(prediction: FrozenPrediction, executionAt: number, rawPrice: number, mark: number,
          sourceFresh: boolean): Promise<ProcessOutcome>;
}

type Pending = { prediction: FrozenPrediction; readyAt: number };

/** Uses only finalized contiguous candles and the first public trade received after inference. */
export class CausalShadowDriver {
  private candles: CanonicalCandle[] = [];
  private pending: Pending | null = null;
  private busy = false;
  private faulted = false;
  constructor(private readonly activationAt: number, private readonly processStartedAt: number,
              private readonly predictor: CausalPredictor, private readonly sink: CausalShadowSink,
              private readonly sourceFresh: () => boolean, private readonly now: () => number = Date.now) {
    if (processStartedAt < activationAt) throw new Error('Process start precedes activation');
    if (sink.snapshot().activationAt !== activationAt) throw new Error('Restored activation mismatch');
    const open = sink.snapshot().open;
    if (open && processStartedAt > open.signalTimestamp + MINUTE) {
      throw new Error('Open position may have missed a frozen 1m monitor during restart');
    }
  }

  seedWarmup(candles: CanonicalCandle[]): void {
    if (this.candles.length || this.pending) throw new Error('Warmup already seeded');
    if (candles.some((c) => c.end >= this.processStartedAt)) throw new Error('Warmup includes current/future decision');
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.end !== candles[i - 1]!.end + MINUTE) throw new Error('Noncontiguous warmup');
    }
    this.candles = candles.slice(-(FROZEN_WARMUP_MINUTES - 1));
  }

  async onFinalizedCandle(candle: CanonicalCandle): Promise<string> {
    if (this.faulted) throw new Error('Shadow driver faulted');
    if (this.busy) throw new Error('Concurrent finalized-candle processing');
    this.busy = true;
    try {
      const last = this.candles.at(-1);
      if (last && candle.end !== last.end + MINUTE) throw new Error('Missing/duplicate finalized candle');
      if (candle.end > this.now()) throw new Error('Future finalized candle');
      if (this.pending) throw new Error('Prior prediction lacks causal execution observation');
      this.candles.push(candle);
      if (this.candles.length > FROZEN_WARMUP_MINUTES) this.candles.shift();
      if (candle.end <= this.processStartedAt) return 'PRE_PROCESS_START';
      const open = this.sink.snapshot().open;
      if (!this.sourceFresh()) {
        if (open) throw new Error('Open position monitor missed due to stale source');
        return 'SOURCE_BLOCKED';
      }
      const action = minuteDecision(candle.end, this.activationAt, open?.signalTimestamp ?? null);
      if (action === 'NO_INFERENCE') return action;
      if (this.candles.length < FROZEN_WARMUP_MINUTES) {
        if (open) throw new Error('Open position without frozen feature warmup');
        return 'WARMING';
      }
      assertCausalCandles(this.candles, candle.end);
      const prediction = await this.predictor.predict([...this.candles], candle.end);
      if (prediction.decisionTimestamp !== candle.end || prediction.featureCutoff > candle.end) {
        throw new Error('Noncausal inference response');
      }
      const actionable = prediction.side !== 'NO_ACTION' && prediction.confidence >= FROZEN.threshold;
      const requiresExecution = action === 'HORIZON_AND_ENTRY_DECISION' ||
        (action === 'ENTRY_DECISION' && actionable && prediction.actionable) ||
        (action === 'FLIP_MONITOR' && open !== null && actionable && prediction.flipActionable &&
          prediction.side !== open.side);
      if (!requiresExecution) {
        const recordedAt = this.now();
        if (recordedAt <= candle.end) throw new Error('Prediction before finalized decision');
        await this.sink.process(prediction, recordedAt, Number(candle.close), Number(candle.close), true);
        return 'NO_ACTION_RECORDED';
      }
      this.pending = { prediction, readyAt: this.now() };
      return action;
    } catch (error) { this.faulted = true; throw error; }
    finally { this.busy = false; }
  }

  async onPublicTrade(trade: CanonicalTrade, mark: number): Promise<ProcessOutcome | null> {
    if (this.faulted || this.busy || !this.pending) return null;
    if (!this.sourceFresh()) return null;
    const pending = this.pending;
    if (trade.receivedAt <= pending.readyAt || trade.timestamp <= pending.readyAt ||
        trade.timestamp < pending.prediction.decisionTimestamp) return null;
    this.pending = null;
    this.busy = true;
    try {
      return await this.sink.process(pending.prediction, trade.receivedAt, Number(trade.price), mark, true);
    } catch (error) { this.faulted = true; throw error; }
    finally { this.busy = false; }
  }

  status() { return { warmupCandles: this.candles.length, pendingDecision: this.pending?.prediction.decisionTimestamp ?? null,
    faulted: this.faulted, processStartedAt: this.processStartedAt }; }
}
