import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MarketRuntime } from '../src/market/market-runtime.js';
import type { BybitPublicWs } from '../src/market/bybit-ws.js';
import type { MarketRepository } from '../src/db/repositories/market.js';
import type { CanonicalTrade } from '../src/types/domain.js';

class FakeWs extends EventEmitter {
  connected = false;
  subscribed = false;
  lastHeartbeat: number | null = null;
  latestTrade: number | null = null;
  reconnectCount = 0;
  stops = 0;
  start(): void {
    this.connected = true;
    this.subscribed = true;
    const trade: CanonicalTrade = { id: 'one', timestamp: Date.now(), receivedAt: Date.now(),
      side: 'Buy', price: '100000', size: '1', sequence: 1, source: 'WEBSOCKET' };
    this.latestTrade = trade.timestamp;
    this.emit('connected');
    this.emit('trade', trade);
  }
  stop(): void { this.stops++; this.connected = false; this.subscribed = false; }
}

describe('market runtime failed startup', () => {
  it('stops its public socket and refuses reuse after REST overlap failure', async () => {
    const ws = new FakeWs();
    const runtime = new MarketRuntime('DRY_RUN', undefined, ws as unknown as BybitPublicWs,
      { recentTrades: async () => { throw new Error('public REST unavailable'); },
        officialOneMinute: async () => { throw new Error('must not fetch kline'); } });
    await expect(runtime.start()).rejects.toThrow('public REST unavailable');
    expect(ws.stops).toBe(1);
    expect(runtime.status()).toMatchObject({ connected: false, continuity: false,
      integrityFault: true, sourceFresh: false });
    await expect(runtime.start()).rejects.toThrow('new instance');
    expect(ws.stops).toBe(1);
  });
  it('bridges the persisted DB tail to current REST/WS before enabling a Node write epoch', async () => {
    const now = Date.now();
    const end = Math.floor(now / 60_000) * 60_000;
    const anchor: CanonicalTrade = { id: 'anchor', timestamp: end - 1000,
      receivedAt: end - 900, side: 'Buy', price: '100000', size: '1', sequence: 1,
      source: 'REST_RECENT' };
    const missing: CanonicalTrade = { ...anchor, id: 'missing', timestamp: end + 1,
      receivedAt: now, sequence: 2 };
    class LiveWs extends FakeWs {
      override start(): void {
        this.connected = true;
        this.subscribed = true;
        this.latestTrade = now;
        this.emit('connected');
        this.emit('trade', { ...anchor, id: 'current', timestamp: now,
          receivedAt: now, sequence: 3, source: 'WEBSOCKET' });
      }
    }
    const ws = new LiveWs();
    let startupHealth = '';
    const repository = { recoveryTail: async () => ({ lastCandleEnd: end,
      previousClose: '100000', lastTrade: anchor, anchorTimestampTrades: [anchor], unfinalizedTrades: [] }),
      recordStartupHealth: async (_state: string, reason: string) => { startupHealth = reason; } } as MarketRepository;
    const runtime = new MarketRuntime('WRITE', repository, ws as unknown as BybitPublicWs,
      { recentTrades: async () => [{ ...anchor, id: 'older', timestamp: anchor.timestamp - 1,
        sequence: 0 }, anchor, missing, { ...anchor, id: 'current',
        timestamp: now, receivedAt: now, sequence: 3, source: 'REST_RECENT' }],
        officialOneMinute: async () => { throw new Error('unneeded'); } }, () => {});
    await runtime.start();
    expect(runtime.status()).toMatchObject({ continuity: true, recoveredTrades: 1,
      lastRestWsOverlap: 1, latestCandle: end });
    expect(startupHealth).toContain('overlap=1 recovered=1');
    runtime.stop();
  });
  it('refuses a DB-to-REST gap even if the new REST/WS overlap is valid', async () => {
    const now = Date.now();
    const end = Math.floor(now / 60_000) * 60_000;
    const anchor: CanonicalTrade = { id: 'old', timestamp: end - 1000,
      receivedAt: end - 900, side: 'Buy', price: '100000', size: '1', sequence: 1,
      source: 'REST_RECENT' };
    class LiveWs extends FakeWs {
      override start(): void {
        this.connected = true;
        this.subscribed = true;
        this.emit('trade', { ...anchor, id: 'new', timestamp: now, receivedAt: now,
          sequence: 2, source: 'WEBSOCKET' });
      }
    }
    const ws = new LiveWs();
    const repository = { recoveryTail: async () => ({ lastCandleEnd: end,
      previousClose: '100000', lastTrade: anchor, anchorTimestampTrades: [anchor], unfinalizedTrades: [] }),
      recordFailure: async () => {} } as MarketRepository;
    const runtime = new MarketRuntime('WRITE', repository, ws as unknown as BybitPublicWs,
      { recentTrades: async () => [{ ...anchor, id: 'new', timestamp: now,
        receivedAt: now, sequence: 2, source: 'REST_RECENT' }],
        officialOneMinute: async () => { throw new Error('unneeded'); } }, () => {});
    await expect(runtime.start()).rejects.toThrow('anchor absent');
    expect(ws.stops).toBe(1);
    expect(runtime.status()).toMatchObject({ continuity: false, integrityFault: true });
  });
});
