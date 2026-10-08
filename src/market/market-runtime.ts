import type { CanonicalCandle, CanonicalTrade } from '../types/domain.js';
import { CandleBuilder, MINUTE } from './candle-builder.js';
import { officialOneMinute, recentTrades } from './bybit-rest.js';
import { BybitPublicWs } from './bybit-ws.js';
import { sameTrade } from './trade-normalizer.js';
import { reconcileRecent } from './reconcile.js';
import { sourceFresh } from './freshness.js';
import type { MarketRepository } from '../db/repositories/market.js';

export type ProducerMode = 'DRY_RUN' | 'READ_ONLY' | 'WRITE';
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
              private readonly beforeWrite?: () => void) {
    this.ws = ws;
    if (mode === 'WRITE' && !repository) throw new Error('WRITE requires dedicated market repository');
    this.ws.on('trade', (trade: CanonicalTrade) => {
      const old = this.buffer.get(trade.id);
      if (old && !sameTrade(old, trade)) { this.fault('Conflicting trade ID'); return; }
      this.buffer.set(trade.id, trade);
      if (this.disconnectAnchor) this.resumedWs.set(trade.id, trade);
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
    this.ws.on('connected', () => { if (this.disconnectAnchor) this.scheduleReconcile(); });
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
    while ((!this.ws.connected || this.buffer.size === 0) && Date.now() < until) await sleep(100);
    if (!this.ws.connected || !this.buffer.size) throw new Error('WS-first buffer unavailable');
    const rest = await this.rest.recentTrades();
    const overlap = rest.filter((x) => this.buffer.has(x.id));
    if (!overlap.length || overlap.some((x) => !sameTrade(x, this.buffer.get(x.id)!))) throw new Error('REST/WS overlap mismatch');
    this.lastOverlap = overlap.length;
    if (this.mode === 'WRITE') {
      const tail = await this.repository!.recoveryTail();
      const byId = new Map(rest.map((trade) => [trade.id, trade]));
      if (tail.unfinalizedTrades.some((trade) => {
        const candidate = byId.get(trade.id);
        return !candidate || !sameTrade(candidate, trade);
      })) throw new Error('Persisted unfinalized trade/REST boundary mismatch');
      const bridge = reconcileRecent(tail.lastTrade, rest, [...this.buffer.values()],
        tail.anchorTimestampTrades);
      for (const trade of [...tail.unfinalizedTrades, ...bridge.recovered]) {
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
      const first = Math.min(...[...this.buffer.values()].map((x) => x.receivedAt));
      this.anchor = Math.floor(first / MINUTE) * MINUTE + MINUTE;
      if (Date.now() < this.anchor + 3000) await sleep(this.anchor + 3000 - Date.now());
      const official = await this.rest.officialOneMinute(this.anchor);
      this.previousClose = official.close;
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
    if (this.mode === 'WRITE') {
      void this.repository!.recordFailure(reason).catch(() => { this.lastError = `${reason}; FAILED health persistence failed`; });
    }
  }
  private scheduleReconcile(): void {
    if (this.integrityFault || this.reconnectTimer || !this.ws.connected || !this.disconnectAnchor) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile().catch((error: unknown) => {
        this.block(String(error));
        this.reconcileAttempts++;
        if (this.reconcileAttempts >= 3) this.fault('Bounded reconnect reconciliation exhausted');
        else if (this.ws.connected && this.disconnectAnchor) this.scheduleReconcile();
      });
    }, 5_000);
  }
  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.disconnectAnchor || !this.ws.connected) return;
    this.reconciling = true;
    try {
      if (this.integrityFault) throw new Error('Integrity fault requires supervised restart');
      const rest = await recentTrades();
      if (!this.ws.connected || this.builder.lateCount || this.integrityFault) throw new Error('Reconnect interrupted or integrity fault');
      const result = reconcileRecent(this.disconnectAnchor, rest, [...this.resumedWs.values()],
        this.disconnectAnchorGroup);
      for (const trade of result.recovered) {
        const old = this.buffer.get(trade.id);
        if (old && !sameTrade(old, trade)) throw new Error('Recovered trade conflicts with WS');
        if (!old) {
          this.buffer.set(trade.id, trade);
          if (this.builder.ingest(trade, true) === 'LATE') throw new Error('Recovered trade after candle finalization');
        }
      }
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
    if (this.ticking || !this.continuity || !this.ws.connected || this.anchor === null || this.previousClose === null) return;
    this.ticking = true;
    try {
    const end = this.anchor + MINUTE;
    if (Date.now() < end + 3000) return;
    const official = await this.rest.officialOneMinute(end);
    const trades = [...this.buffer.values()].filter((x) => x.timestamp >= end - MINUTE && x.timestamp < end);
    const candle: CanonicalCandle = this.builder.finalize(end, Date.now(), this.previousClose, official);
    if (this.mode === 'WRITE') {
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
