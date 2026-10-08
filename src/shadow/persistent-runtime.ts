import type { CanonicalTrade, FrozenPrediction } from '../types/domain.js';
import type { MarketReadRepository } from '../db/repositories/market-read.js';
import type { OperationalSourceSnapshot } from '../report/shadow-snapshot.js';
import type { CausalPredictor } from './causal-driver.js';
import type { ShadowJournal } from './shadow-coordinator.js';
import { ShadowCoordinator } from './shadow-coordinator.js';
import { ShadowMarketObserver } from './market-observer.js';
import type { ShadowState } from './shadow-engine.js';

export interface PublicMarketRuntime {
  start(): Promise<void>;
  stop(): void;
  status(): { sourceFresh: boolean; integrityFault: boolean; latestTrade?: number | null };
  ws: {
    on(event: 'trade', listener: (trade: CanonicalTrade) => void): unknown;
    off(event: 'trade', listener: (trade: CanonicalTrade) => void): unknown;
  };
}

export interface InferenceRuntime extends CausalPredictor {
  start(): Promise<void>;
  stop(): void;
}

export type ShadowRuntimeStatus = {
  started: boolean;
  faulted: boolean;
  sourceFresh: boolean;
  lastCandle: number | null;
  pendingDecision: number | null;
};

/** Restore-only supervisor. An operator-approved activation must already exist in the append-only journal. */
export class ShadowPersistentRuntime {
  private observer: ShadowMarketObserver | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inTick = false;
  private faulted = false;
  private started = false;
  private stopping = false;
  private coordinator: ShadowCoordinator | null = null;
  private lastPrediction: FrozenPrediction | null = null;
  private lastMark: number | null = null;
  private lastPublicTrade: number | null = null;
  private readonly tradeListener = (trade: CanonicalTrade) => {
    if (!this.observer || this.faulted) return;
    const price = Number(trade.price);
    if (!Number.isFinite(price) || price <= 0) {
      this.fail(new Error('Invalid public execution observation'));
      return;
    }
    this.lastMark = price;
    this.lastPublicTrade = trade.timestamp;
    void this.observer
      .onPublicTrade(trade)
      .catch((error: unknown) => this.fail(error));
  };

  constructor(
    private readonly publicMarket: PublicMarketRuntime,
    private readonly reader: Pick<
      MarketReadRepository,
      'warmupBefore' | 'finalizedAfter' | 'sourceState'
    >,
    private readonly model: InferenceRuntime,
    private readonly journal: ShadowJournal,
    private readonly activationId: string,
    private readonly lotSize: number,
    private readonly verifyRole: () => Promise<void>,
    private readonly onFault: (error: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async start(maxWaitMs = 180_000): Promise<void> {
    if (this.started || this.faulted)
      throw new Error('Shadow runtime already started/faulted');
    this.stopping = false;
    if (!Number.isInteger(this.lotSize) || this.lotSize < 1)
      throw new Error('Verified inverse contract lot size required');
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0)
      throw new Error('Invalid source wait');
    try {
      await this.verifyRole();
      const restored = await this.journal.restore(this.activationId);
      if (!restored || restored.activationId !== this.activationId) {
        throw new Error('Verified Shadow activation journal missing');
      }
      await this.model.start();
      await this.publicMarket.start();
      const deadline = this.now() + maxWaitMs;
      while (!this.publicStreamReady()) {
        if (this.now() >= deadline)
          throw new Error('Reconciled public market did not become fresh');
        await this.sleep(1000);
      }
      const latest = await this.reader.warmupBefore(this.now(), 1);
      const mark = Number(latest.at(-1)?.close);
      if (!Number.isFinite(mark) || mark <= 0)
        throw new Error('Public canonical initial mark unavailable');
      this.lastMark = mark;
      const coordinator = await ShadowCoordinator.resume(
        this.journal,
        this.activationId,
        restored.state.activationAt,
        mark,
        this.lotSize,
      );
      this.coordinator = coordinator;
      const predictor: CausalPredictor = { predict: async (candles, decisionTimestamp) => {
        const prediction = await this.model.predict(candles, decisionTimestamp);
        this.lastPrediction = prediction;
        return prediction;
      } };
      const observer = new ShadowMarketObserver(
        this.reader,
        predictor,
        coordinator,
        restored.state.activationAt,
        () => this.publicStreamReady(),
        this.now,
      );
      await observer.start();
      this.observer = observer;
      this.publicMarket.ws.on('trade', this.tradeListener);
      this.timer = setInterval(() => {
        void this.pollOnce().catch((error: unknown) => this.fail(error));
      }, 1000);
      this.started = true;
    } catch (error) {
      this.faulted = true;
      this.stop();
      throw error;
    }
  }

  private publicStreamReady(): boolean {
    const status = this.publicMarket.status();
    return !this.stopping && status.sourceFresh && !status.integrityFault;
  }

  async pollOnce(): Promise<string[]> {
    if (!this.started || !this.observer || this.faulted)
      throw new Error('Shadow runtime not ready');
    if (this.inTick) return [];
    this.inTick = true;
    try {
      if (!this.publicStreamReady())
        throw new Error('Public stream lost reconciliation/freshness');
      return await this.observer.pollOnce();
    } finally {
      this.inTick = false;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.publicMarket.ws.off('trade', this.tradeListener);
    this.publicMarket.stop();
    this.model.stop();
    this.started = false;
  }

  private fail(error: unknown): void {
    if (this.faulted || this.stopping) return;
    this.faulted = true;
    this.stop();
    this.onFault(error);
  }

  halt(error: unknown): void { this.fail(error); }

  status(): ShadowRuntimeStatus {
    const observation = this.observer?.status();
    return {
      started: this.started,
      faulted: this.faulted || observation?.faulted === true,
      sourceFresh:
        this.started &&
        !this.faulted &&
        this.publicStreamReady() &&
        observation?.sourceFresh === true,
      lastCandle: observation?.cursor ?? null,
      pendingDecision: observation?.pendingDecision ?? null,
    };
  }

  committedState(): ShadowState | null { return this.coordinator?.snapshot() ?? null; }
  latestSignal(): FrozenPrediction | null { return this.lastPrediction; }
  reportSource(): OperationalSourceSnapshot {
    return { latestTradeTimestamp: this.lastPublicTrade ?? this.publicMarket.status().latestTrade ?? null,
      sourceFresh: this.status().sourceFresh, markPrice: this.lastMark };
  }
}
