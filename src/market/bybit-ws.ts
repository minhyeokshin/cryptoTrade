import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import type { CanonicalTrade } from '../types/domain.js';
import { normalizeWsTrade } from './trade-normalizer.js';

const PUBLIC_WS_URL = 'wss://stream.bybit.com/v5/public/inverse';
const TOPICS = ['publicTrade.BTCUSD', 'kline.1.BTCUSD', 'kline.5.BTCUSD'];

export class BybitPublicWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private generation = 0;
  private frameCommitter: ((trades: CanonicalTrade[]) => Promise<void>) | null = null;
  private frameQueue: Promise<void> = Promise.resolve();
  pendingFrames = 0;
  setFrameCommitter(commit: (trades: CanonicalTrade[]) => Promise<void>): void {
    if (this.ws || this.frameCommitter) throw new Error('Journal gate must be installed before WS start');
    this.frameCommitter = commit;
  }
  async drainJournal(): Promise<void> { await this.frameQueue; }
  connected = false;
  subscribed = false;
  lastHeartbeat: number | null = null;
  latestTrade: number | null = null;
  reconnectCount = 0;
  constructor(private readonly url = PUBLIC_WS_URL,
              private readonly socketFactory: (url: string) => WebSocket = (address) => new WebSocket(address)) {
    super();
    if (new URL(url).protocol !== 'wss:' || !url.includes('/v5/public/inverse')) throw new Error('Private/non-inverse WS forbidden');
  }
  start(): void {
    if (this.ws || this.retry) throw new Error('Public WebSocket already started');
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connected = false;
    this.subscribed = false;
  }
  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const connectionId = randomUUID();
    let messageOrdinal = 0;
    let receiveOrder = 0;
    const ws = this.socketFactory(this.url);
    this.ws = ws;
    const current = () => !this.stopped && this.generation === generation && this.ws === ws;
    ws.on('open', () => {
      if (!current()) { ws.close(); return; }
      this.connected = true; this.lastHeartbeat = Date.now();
      this.subscribed = false;
      ws.send(JSON.stringify({ op: 'subscribe', args: TOPICS }));
      this.emit('connected');
      this.timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20_000);
    });
    ws.on('pong', () => { if (current()) this.lastHeartbeat = Date.now(); });
    ws.on('message', (raw) => {
      if (!current()) return;
      const rawMessage = raw.toString();
      let message: { op?: string; success?: boolean; type?: string; topic?: string;
        id?: string; data?: unknown[] | { successTopics?: string[]; failTopics?: string[] } };
      try { message = JSON.parse(rawMessage) as typeof message; }
      catch (error) { this.emit('error', error); return; }
      if (message.op === 'subscribe' || message.type === 'COMMAND_RESP') {
        const topics = !Array.isArray(message.data) && message.data?.successTopics;
        const failures = !Array.isArray(message.data) && message.data?.failTopics;
        if (message.success !== true || (topics && TOPICS.some((topic) => !topics.includes(topic))) ||
            (failures && failures.length > 0)) {
          this.emit('error', new Error('Public trade subscription rejected or incomplete')); return;
        }
        this.subscribed = true;
        this.emit('subscribed');
        return;
      }
      if (message.topic === 'publicTrade.BTCUSD') {
        try {
          if (!Array.isArray(message.data)) throw new Error('Invalid public trade message data');
          const ordinal = ++messageOrdinal;
          const receivedAt = Date.now();
          const messageHash = createHash('sha256').update(rawMessage).digest('hex');
          const trades: CanonicalTrade[] = message.data.map((x, messageIndex) => ({
            ...normalizeWsTrade(x, receivedAt),
            witness: { connectionId, messageOrdinal: ordinal, messageIndex,
              receiveOrder: ++receiveOrder, receivedAt, messageHash, rawMessage,
              exchangeMessageId: message.id ?? null },
          }));
          if (!this.frameCommitter) {
            for (const trade of trades) { this.latestTrade = trade.timestamp; this.emit('trade', trade); }
          } else {
            if (++this.pendingFrames > 1024) throw new Error('Journal backlog limit exceeded');
            this.frameQueue = this.frameQueue.then(async () => {
              // Frames queued before disconnect are still durable evidence. Stop/failure
              // never publishes them; a supervised restart may later replay them.
              await this.frameCommitter!(trades);
              if (current()) for (const trade of trades) {
                this.latestTrade = trade.timestamp; this.emit('trade', trade);
              }
            });
            void this.frameQueue.catch((error: unknown) => {
              this.stop();
              this.emit('error', error instanceof Error ? error : new Error(String(error)));
            }).finally(() => { this.pendingFrames--; });
          }
        } catch (error) {
          if (this.frameCommitter) this.stop();
          this.emit('error', error);
        }
      } else if (message.topic?.startsWith('kline.')) this.emit('kline', message);
    });
    ws.on('error', (error) => { if (current()) this.emit('error', error); });
    ws.on('close', () => {
      if (!current()) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.ws = null;
      this.connected = false; this.subscribed = false; this.emit('disconnected');
      if (!this.stopped) {
        this.reconnectCount++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectCount, 5));
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
      }
    });
  }
}
