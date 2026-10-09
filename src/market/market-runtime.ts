import type { CanonicalCandle, CanonicalTrade } from '../types/domain.js';
import { CandleBuilder, MINUTE } from './candle-builder.js';
import { officialOneMinute, recentTrades } from './bybit-rest.js';
import { BybitPublicWs } from './bybit-ws.js';
import { sameTrade } from './trade-normalizer.js';
import { reconcileRecent } from './reconcile.js';
import { verifyCurrentOverlap } from './current-overlap.js';
import { sourceFresh } from './freshness.js';
import type { MarketRepository } from '../db/repositories/market.js';
import { orderReplay } from './replay-order.js';

export type ProducerMode = 'DRY_RUN' | 'READ_ONLY' | 'WRITE' | 'NEW_LIVE_EPOCH';
type PublicRest = { recentTrades: typeof recentTrades; officialOneMinute: typeof officialOneMinute };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class MarketRuntime {
  readonly ws: BybitPublicWs;
  private readonly builder = new CandleBuilder();
  private readonly buffer = new Map<string, CanonicalTrade>();
  private anchor: number | null = null;
  private previousClose: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private ticking = false;
  private continuity = false;
  private integrityFault = false;
  private lastObserved: CanonicalTrade | null = null;
  private disconnectAnchor: CanonicalTrade | null = null;
  private disconnectAnchorGroup: CanonicalTrade[] = [];
  private readonly resumedWs = new Map<string, CanonicalTrade>();
  private recoveredTrades = 0;
  private lastOverlap = 0;
  private reconcileAttempts = 0;
  private lastCandle: number | null = null;
  private lastError: string | null = null;
  private candles = 0;
  private attempted = false;
  constructor(private readonly mode: ProducerMode, private readonly repository?: MarketRepository,
              ws: BybitPublicWs = new BybitPublicWs(),
              private readonly rest: PublicRest = { recentTrades, officialOneMinute },
              private readonly beforeWrite?: () => void,
              private readonly newEpoch?: { expectedGapStart: number;
                record: (gapStart: number, firstVerified: CanonicalTrade, minuteStart: number) => Promise<void> }) {
    this.ws = ws;
    if ((mode === 'WRITE' || mode === 'NEW_LIVE_EPOCH') && !repository) throw new Error('WRITE requires dedicated market repository');
    if (mode === 'NEW_LIVE_EPOCH' && !newEpoch) throw new Error('Explicit new live epoch approval required');
    if (mode === 'WRITE' || mode === 'NEW_LIVE_EPOCH') {
      this.ws.setFrameCommitter((trades) => this.repository!.journalFrame(trades));
    }
    this.ws.on('trade', (trade: CanonicalTrade) => {
      const old = this.buffer.get(trade.id);
      if (old && !sameTrade(old, trade)) { this.fault('Conflicting trade ID'); return; }
      // A replayed ID must not replace the original immutable WS ordering witness.
      if (!old) this.buffer.set(trade.id, trade);
      if (this.disconnectAnchor && !this.resumedWs.has(trade.id)) this.resumedWs.set(trade.id, trade);
      this.lastObserved = trade;
      try { if (this.builder.ingest(trade) === 'LATE') this.fault('Late trade'); }
      catch (error) { this.fault(String(error)); }
    });
    this.ws.on('disconnected', () => {
      if (this.anchor !== null && !this.disconnectAnchor) {
        this.disconnectAnchor = this.lastObserved;
        this.disconnectAnchorGroup = this.lastObserved ?
          [...this.buffer.values()].filter((trade) => trade.timestamp === this.lastObserved!.timestamp) : [];
      }
      this.block('WebSocket disconnected; reconcile before resume');
    });
    this.ws.on('subscribed', () => { if (this.disconnectAnchor) this.scheduleReconcile(); });
    this.ws.on('error', (error: Error) => this.fault(error.message));
  }
  status() {
    return { connected: this.ws.connected, lastHeartbeat: this.ws.lastHeartbeat,
      latestTrade: this.ws.latestTrade, latestCandle: this.lastCandle,
      reconnectCount: this.ws.reconnectCount, duplicateCount: this.builder.duplicateCount,
      orderingViolations: this.builder.orderingViolations, lateCount: this.builder.lateCount,
      recoveredTrades: this.recoveredTrades, lastRestWsOverlap: this.lastOverlap,
      reconcileAttempts: this.reconcileAttempts,
      finalizedCandles: this.candles, continuity: this.continuity,
      integrityFault: this.integrityFault,
      sourceFresh: sourceFresh(Date.now(), this.ws.latestTrade, this.lastCandle,
        this.ws.connected, this.continuity), lastError: this.lastError,
      historicalSourceGap: 'OPEN', mode: this.mode };
  }
  async start(): Promise<void> {
    if (this.attempted) throw new Error('Market runtime requires a new instance after stop/failure');
    this.attempted = true;
    try {
    this.ws.start();
    const until = Date.now() + 30_000;
    while ((!this.ws.connected || !this.ws.subscribed || this.buffer.size === 0) &&
      !this.integrityFault && Date.now() < until) await sleep(100);
    if (!this.ws.connected || !this.ws.subscribed || !this.buffer.size) throw new Error('WS-first open/subscribe/trade unavailable');
    const rest = await this.rest.recentTrades();
    const current = verifyCurrentOverlap(rest, [...this.buffer.values()]);
    this.lastOverlap = current.overlap;
    if (this.mode === 'WRITE') {
      const tail = await this.repository!.recoveryTail();
      const journal = await this.repository!.replayJournal(Math.min(tail.lastTrade.timestamp, tail.lastCandleEnd));
      await this.repository!.verifyPersistedWsWitnesses([
        ...tail.anchorTimestampTrades, ...tail.unfinalizedTrades]);
      const byId = new Map(rest.map((trade) => [trade.id, trade]));
      if (tail.unfinalizedTrades.some((trade) => {
        const candidate = byId.get(trade.id);
        return !candidate || !sameTrade(candidate, trade);
      })) throw new Error('Persisted unfinalized trade/REST boundary mismatch');
      const unfinalizedGroups = new Map<string, CanonicalTrade[]>();
      for (const trade of tail.unfinalizedTrades) {
        const key = `${trade.timestamp}:${trade.sequence ?? 'NULL'}`;
        const group = unfinalizedGroups.get(key) ?? [];
        group.push(trade);
        unfinalizedGroups.set(key, group);
      }
      if ([...unfinalizedGroups.values()].some((group) => group.length > 1 &&
          group.some((trade) => !this.buffer.has(trade.id) && !journal.some((j) => j.id === trade.id)))) {
        throw new Error('Unfinalized persisted tied group lacks WS ordering witness');
      }
      const bridge = reconcileRecent(tail.lastTrade, rest, [...this.buffer.values()],
        tail.anchorTimestampTrades, journal);
      const replay = [...tail.unfinalizedTrades, ...bridge.recovered];
      const ordered = orderReplay([...replay, ...this.buffer.values()], [...journal, ...this.buffer.values()]);
      // Rebuild the unfinalized buffer using proved source order, never arrival order of recovery queries.
      this.builder.resetUnfinalized();
      this.buffer.clear();
      for (const trade of ordered.filter((t) => t.timestamp >= tail.lastCandleEnd)) {
        const old = this.buffer.get(trade.id);
        if (old && !sameTrade(old, trade)) throw new Error('Canonical startup trade conflict');
        if (!old) {
          this.buffer.set(trade.id, trade);
          if (this.builder.ingest(trade, true) === 'LATE') throw new Error('Startup recovery after finalization');
        }
      }
      this.anchor = tail.lastCandleEnd;
      this.previousClose = tail.previousClose;
      this.lastCandle = tail.lastCandleEnd;
      this.recoveredTrades += bridge.recovered.length;
      this.lastOverlap = bridge.overlap;
      await this.repository!.recordStartupHealth('BACKFILLING',
        `DB/REST/WS overlap=${bridge.overlap} recovered=${bridge.recovered.length} anchor=${tail.lastTrade.id}`);
    } else {
      if (this.mode === 'NEW_LIVE_EPOCH') {
        const gapStart = await this.repository!.historicalGapStart();
        if (gapStart !== this.newEpoch!.expectedGapStart) throw new Error('Historical gap start changed after approval');
        if (current.firstVerified.timestamp <= gapStart) throw new Error('New live epoch does not follow historical tail');
      }
      const first = Math.min(...[...this.buffer.values()].map((x) => x.receivedAt));
      this.anchor = Math.floor(Math.max(first, Date.now()) / MINUTE) * MINUTE + MINUTE;
      if (Date.now() < this.anchor + 3000) await sleep(this.anchor + 3000 - Date.now());
      const official = await this.rest.officialOneMinute(this.anchor);
      this.previousClose = official.close;
      for (const [id, trade] of this.buffer) if (trade.timestamp < this.anchor) this.buffer.delete(id);
      this.builder.discardBefore(this.anchor);
      if (this.mode === 'NEW_LIVE_EPOCH') {
        if (!this.ws.connected || !this.ws.subscribed || this.lastError || this.integrityFault) {
          throw new Error('New live epoch lost WS integrity before boundary');
        }
        await this.newEpoch!.record(this.newEpoch!.expectedGapStart, current.firstVerified, this.anchor);
      }
    }
    if (!this.ws.connected || this.lastError) throw new Error('WS/continuity lost during startup');
    this.continuity = true;
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => this.fault(String(error))); }, 1000);
    } catch (error) {
      this.fault(String(error));
      this.stop();
      throw error;
    }
  }
  stop(): void {
    this.ws.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.continuity = false;
  }
  private block(reason: string): void { this.continuity = false; this.lastError = reason; }
  private fault(reason: string): void {
    if (this.integrityFault) return;
    this.integrityFault = true;
    this.block(reason);
    if (this.mode === 'WRITE' || this.mode === 'NEW_LIVE_EPOCH') {
      void this.repository!.recordFailure(reason).catch(() => { this.lastError = `${reason}; FAILED health persistence failed`; });
    }
  }
  private scheduleReconcile(): void {
    if (this.integrityFault || this.reconnectTimer || !this.ws.connected ||
        !this.ws.subscribed || !this.disconnectAnchor) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile().catch((error: unknown) => {
        this.block(String(error));
        this.reconcileAttempts++;
        if (this.reconcileAttempts >= 3) this.fault('Bounded reconnect reconciliation exhausted');
        else if (this.ws.connected && this.ws.subscribed && this.disconnectAnchor) this.scheduleReconcile();
      });
    }, 5_000);
  }
  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.disconnectAnchor || !this.ws.connected || !this.ws.subscribed) return;
    this.reconciling = true;
    try {
      if (this.integrityFault) throw new Error('Integrity fault requires supervised restart');
      const rest = await this.rest.recentTrades();
      if (!this.ws.connected || !this.ws.subscribed || this.builder.lateCount || this.integrityFault) throw new Error('Reconnect interrupted or integrity fault');
      const journal = this.repository && (this.mode === 'WRITE' || this.mode === 'NEW_LIVE_EPOCH') ?
        await this.repository.replayJournal(this.disconnectAnchor.timestamp) : [];
      const result = reconcileRecent(this.disconnectAnchor, rest, [...this.resumedWs.values()],
        this.disconnectAnchorGroup, journal);
      for (const trade of result.recovered) {
        const old = this.buffer.get(trade.id);
        if (old && !sameTrade(old, trade)) throw new Error('Recovered trade conflicts with WS');
        if (!old) {
          this.buffer.set(trade.id, trade);
          if (this.builder.ingest(trade, true) === 'LATE') throw new Error('Recovered trade after candle finalization');
        }
      }
      const ordered = orderReplay([...this.buffer.values()], [...journal, ...this.buffer.values()]);
      this.builder.rebuildUnfinalized(ordered);
      this.buffer.clear(); ordered.forEach((t) => this.buffer.set(t.id,t));
      this.recoveredTrades += result.recovered.length;
      this.lastOverlap = result.overlap;
      this.reconcileAttempts = 0;
      this.disconnectAnchor = null;
      this.disconnectAnchorGroup = [];
      this.resumedWs.clear();
      this.lastError = null;
      this.continuity = true;
    } finally { this.reconciling = false; }
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.ws.pendingFrames > 0 || !this.continuity || !this.ws.connected || this.anchor === null || this.previousClose === null) return;
    this.ticking = true;
    try {
    const end = this.anchor + MINUTE;
    if (Date.now() < end + 3000) return;
    const official = await this.rest.officialOneMinute(end);
    if (this.ws.pendingFrames > 0 || !this.continuity || this.integrityFault) return;
    const trades = [...this.buffer.values()].filter((x) => x.timestamp >= end - MINUTE && x.timestamp < end);
    const candle: CanonicalCandle = this.builder.finalize(end, Date.now(), this.previousClose, official);
    if (this.mode === 'WRITE' || this.mode === 'NEW_LIVE_EPOCH') {
      this.beforeWrite?.();
      const nextCount = this.candles + 1;
      const anomaly = this.builder.orderingViolations > 0 || this.builder.lateCount > 0;
      const fresh = sourceFresh(Date.now(), this.ws.latestTrade, end, this.ws.connected, this.continuity);
      const health = anomaly ? 'DEGRADED' : !fresh ? 'STALE' : nextCount < 3 ? 'WARMING' : 'HEALTHY';
      await this.repository!.persist(candle, trades, health);
    }
    this.anchor = end; this.previousClose = candle.close;
    this.lastCandle = end; this.candles++;
    for (const [id, trade] of this.buffer) if (trade.timestamp < end) this.buffer.delete(id);
    } finally { this.ticking = false; }
  }
}
