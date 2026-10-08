import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MarketRuntime } from '../src/market/market-runtime.js';
import type { BybitPublicWs } from '../src/market/bybit-ws.js';
import type { CanonicalTrade } from '../src/types/domain.js';

class FakeWs extends EventEmitter {
  connected = false;
  lastHeartbeat: number | null = null;
  latestTrade: number | null = null;
  reconnectCount = 0;
  stops = 0;
  start(): void {
    this.connected = true;
    const trade: CanonicalTrade = { id: 'one', timestamp: Date.now(), receivedAt: Date.now(),
      side: 'Buy', price: '100000', size: '1', sequence: 1, source: 'WEBSOCKET' };
    this.latestTrade = trade.timestamp;
    this.emit('connected');
    this.emit('trade', trade);
  }
  stop(): void { this.stops++; this.connected = false; }
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
});
