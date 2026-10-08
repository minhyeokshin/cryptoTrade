import type { MarketReadRepository } from '../db/repositories/market-read.js';
import type { CanonicalTrade } from '../types/domain.js';
import { CausalShadowDriver, type CausalPredictor, type CausalShadowSink } from './causal-driver.js';
import type { ProcessOutcome } from './shadow-coordinator.js';

const MINUTE = 60_000;
const MAX_SOURCE_LAG = 180_000;
const WARMUP = 11_999;
type SourceState = Awaited<ReturnType<MarketReadRepository['sourceState']>>;

/** Freshness is necessary but not sufficient: the public stream must also be reconciled. */
export function sourceSnapshotFresh(state: SourceState, now: number): boolean {
  return state.health === 'HEALTHY' &&
    (state.latestCandleStatus === 'HEALTHY' || state.latestCandleStatus === 'LIVE_CURRENT_EPOCH') &&
    state.latestTrade !== null && state.latestCandle !== null && state.healthAt !== null &&
    state.healthAt <= now && state.latestTrade <= now && state.latestCandle < now &&
    now - state.latestTrade < MAX_SOURCE_LAG && now - state.latestCandle < MAX_SOURCE_LAG;
}

/** Dedicated-role DB candle observer. Never starts a service or creates an activation event. */
export class ShadowMarketObserver {
  private driver: CausalShadowDriver | null = null;
  private cursor: number | null = null;
  private sourceState: SourceState | null = null;
  private faulted = false;
  constructor(private readonly market: Pick<MarketReadRepository,
                'warmupBefore' | 'finalizedAfter' | 'sourceState'>,
              private readonly predictor: CausalPredictor,
              private readonly sink: CausalShadowSink,
              private readonly activationAt: number,
              private readonly publicStreamReady: () => boolean,
              private readonly now: () => number = Date.now) {}

  private fresh(): boolean {
    return !this.faulted && this.publicStreamReady() && this.sourceState !== null &&
      sourceSnapshotFresh(this.sourceState, this.now());
  }

  async start(): Promise<void> {
    if (this.driver || this.faulted) throw new Error('Shadow observer already started/faulted');
    const started = this.now();
    const state = await this.market.sourceState();
    if (!this.publicStreamReady() || !sourceSnapshotFresh(state, started)) {
      throw new Error('Shadow source not freshly reconciled');
    }
    if (state.latestCandle! >= started) throw new Error('Latest candle is not finalized before start');
    const warmup = await this.market.warmupBefore(started, WARMUP);
    if (warmup.length !== WARMUP || warmup.at(-1)?.end !== state.latestCandle) {
      throw new Error('Complete current-epoch frozen warmup unavailable');
    }
    const driver = new CausalShadowDriver(this.activationAt, started, this.predictor, this.sink,
      () => this.fresh(), this.now);
    driver.seedWarmup(warmup);
    this.sourceState = state;
    this.cursor = state.latestCandle;
    this.driver = driver;
  }

  async pollOnce(): Promise<string[]> {
    if (!this.driver || this.cursor === null || this.faulted) throw new Error('Shadow observer not ready');
    try {
      this.sourceState = await this.market.sourceState();
      if (!this.fresh()) throw new Error('Shadow source stale or public stream unreconciled');
      const candles = await this.market.finalizedAfter(this.cursor);
      const results: string[] = [];
      for (const candle of candles) {
        const now = this.now();
        if (candle.end <= this.cursor || candle.end > now || now - candle.end >= MINUTE) {
          throw new Error('Delayed or duplicate causal candle');
        }
        results.push(await this.driver.onFinalizedCandle(candle));
        this.cursor = candle.end;
      }
      return results;
    } catch (error) { this.faulted = true; throw error; }
  }

  async onPublicTrade(trade: CanonicalTrade): Promise<ProcessOutcome | null> {
    if (!this.driver || !this.fresh() || trade.source !== 'WEBSOCKET') return null;
    return this.driver.onPublicTrade(trade, Number(trade.price));
  }

  status() { return { started: this.driver !== null, cursor: this.cursor, sourceFresh: this.fresh(),
    faulted: this.faulted || this.driver?.status().faulted === true,
    pendingDecision: this.driver?.status().pendingDecision ?? null }; }
}
