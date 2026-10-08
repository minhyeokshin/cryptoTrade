import type { CanonicalCandle, CanonicalTrade } from '../types/domain.js';
import { CandleBuilder, MINUTE } from './candle-builder.js';
import { officialOneMinute, recentTrades } from './bybit-rest.js';
import { BybitPublicWs } from './bybit-ws.js';
import { sameTrade } from './trade-normalizer.js';
import { sourceFresh } from './freshness.js';
import type { MarketRepository } from '../db/repositories/market.js';

export type ProducerMode = 'DRY_RUN' | 'READ_ONLY' | 'WRITE';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class MarketRuntime {
  readonly ws = new BybitPublicWs();
  private readonly builder = new CandleBuilder();
  private readonly buffer = new Map<string, CanonicalTrade>();
  private anchor: number | null = null;
  private previousClose: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private continuity = false;
  private lastCandle: number | null = null;
  private lastError: string | null = null;
  private candles = 0;
  constructor(private readonly mode: ProducerMode, private readonly repository?: MarketRepository) {
    if (mode === 'WRITE' && !repository) throw new Error('WRITE requires dedicated market repository');
    this.ws.on('trade', (trade: CanonicalTrade) => {
      const old = this.buffer.get(trade.id);
      if (old && !sameTrade(old, trade)) { this.block('Conflicting trade ID'); return; }
      this.buffer.set(trade.id, trade);
      try { if (this.builder.ingest(trade) === 'LATE') this.block('Late trade'); }
      catch (error) { this.block(String(error)); }
    });
    this.ws.on('disconnected', () => this.block('WebSocket disconnected; reconcile before resume'));
    this.ws.on('error', (error: Error) => this.block(error.message));
  }
  status() {
    return { connected: this.ws.connected, lastHeartbeat: this.ws.lastHeartbeat,
      latestTrade: this.ws.latestTrade, latestCandle: this.lastCandle,
      reconnectCount: this.ws.reconnectCount, duplicateCount: this.builder.duplicateCount,
      orderingViolations: this.builder.orderingViolations, lateCount: this.builder.lateCount,
      finalizedCandles: this.candles, continuity: this.continuity,
      sourceFresh: sourceFresh(Date.now(), this.ws.latestTrade, this.lastCandle,
        this.ws.connected, this.continuity), lastError: this.lastError,
      historicalSourceGap: 'OPEN', mode: this.mode };
  }
  async start(): Promise<void> {
    this.ws.start();
    const until = Date.now() + 30_000;
    while ((!this.ws.connected || this.buffer.size === 0) && Date.now() < until) await sleep(100);
    if (!this.ws.connected || !this.buffer.size) throw new Error('WS-first buffer unavailable');
    const rest = await recentTrades();
    const overlap = rest.filter((x) => this.buffer.has(x.id));
    if (!overlap.length || overlap.some((x) => !sameTrade(x, this.buffer.get(x.id)!))) throw new Error('REST/WS overlap mismatch');
    const first = Math.min(...[...this.buffer.values()].map((x) => x.receivedAt));
    this.anchor = Math.floor(first / MINUTE) * MINUTE + MINUTE;
    if (Date.now() < this.anchor + 3000) await sleep(this.anchor + 3000 - Date.now());
    if (!this.ws.connected || this.lastError) throw new Error('WS/continuity lost during startup');
    const official = await officialOneMinute(this.anchor);
    this.previousClose = official.close;
    this.continuity = true;
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => this.block(String(error))); }, 1000);
  }
  stop(): void { this.ws.stop(); if (this.timer) clearInterval(this.timer); this.continuity = false; }
  private block(reason: string): void { this.continuity = false; this.lastError = reason; }
  private async tick(): Promise<void> {
    if (!this.continuity || !this.ws.connected || this.anchor === null || this.previousClose === null) return;
    const end = this.anchor + MINUTE;
    if (Date.now() < end + 3000) return;
    const official = await officialOneMinute(end);
    const trades = [...this.buffer.values()].filter((x) => x.timestamp >= end - MINUTE && x.timestamp < end);
    const candle: CanonicalCandle = this.builder.finalize(end, Date.now(), this.previousClose, official);
    if (this.mode === 'WRITE') await this.repository!.persist(candle, trades);
    this.anchor = end; this.previousClose = candle.close;
    this.lastCandle = end; this.candles++;
    for (const [id, trade] of this.buffer) if (trade.timestamp < end) this.buffer.delete(id);
  }
}
