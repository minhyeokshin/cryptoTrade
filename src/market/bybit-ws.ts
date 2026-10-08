import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { CanonicalTrade } from '../types/domain.js';
import { normalizeWsTrade } from './trade-normalizer.js';

const PUBLIC_WS_URL = 'wss://stream.bybit.com/v5/public/inverse';
const TOPICS = ['publicTrade.BTCUSD', 'kline.1.BTCUSD', 'kline.5.BTCUSD'];

export class BybitPublicWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  connected = false;
  lastHeartbeat: number | null = null;
  latestTrade: number | null = null;
  reconnectCount = 0;
  constructor(private readonly url = PUBLIC_WS_URL) {
    super();
    if (new URL(url).protocol !== 'wss:' || !url.includes('/v5/public/inverse')) throw new Error('Private/non-inverse WS forbidden');
  }
  start(): void { this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.connected = false;
  }
  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true; this.lastHeartbeat = Date.now();
      ws.send(JSON.stringify({ op: 'subscribe', args: TOPICS }));
      this.emit('connected');
      this.timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20_000);
    });
    ws.on('pong', () => { this.lastHeartbeat = Date.now(); });
    ws.on('message', (raw) => {
      let message: { topic?: string; data?: unknown[] };
      try { message = JSON.parse(raw.toString()) as typeof message; }
      catch (error) { this.emit('error', error); return; }
      if (message.topic === 'publicTrade.BTCUSD') {
        try {
          const trades: CanonicalTrade[] = (message.data ?? []).map((x) => normalizeWsTrade(x));
          for (const trade of trades) { this.latestTrade = trade.timestamp; this.emit('trade', trade); }
        } catch (error) { this.emit('error', error); }
      } else if (message.topic?.startsWith('kline.')) this.emit('kline', message);
    });
    ws.on('error', (error) => this.emit('error', error));
    ws.on('close', () => {
      if (this.timer) clearInterval(this.timer);
      this.connected = false; this.emit('disconnected');
      if (!this.stopped) {
        this.reconnectCount++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectCount, 5));
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
}
