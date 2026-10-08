import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.js';
import { shadowDbView } from '../src/api/shadow-db-view.js';
import type { MarketReadRepository } from '../src/db/repositories/market-read.js';
import type { ShadowStateStore } from '../src/shadow/state-store.js';

const at = Date.parse('2026-10-08T12:00:00Z');
const activationId = '11111111-1111-4111-8111-111111111111';

function fakeMarket() {
  return {
    sourceState: async () => ({ latestTrade: at - 1_000, latestCandle: at - 60_000,
      latestCandleStatus: 'HEALTHY', health: 'HEALTHY', healthAt: at - 1_000 }),
    warmupBefore: async () => [{ end: at - 60_000, open: '100000', high: '100000',
      low: '100000', close: '100000', volume: '1', tradeCount: 1,
      firstTradeTimestamp: at - 120_000, lastTradeTimestamp: at - 61_000 }],
  } as Pick<MarketReadRepository, 'sourceState' | 'warmupBefore'>;
}

describe('Shadow journal read-only API', () => {
  it('does not claim live runtime or public WS readiness from a fresh database snapshot', async () => {
    const journal = { restore: async () => ({ activationId, lastSignalTimestamp: null,
      state: { activationAt: at - 300_000, balanceBtc: 0.001, open: null, closed: [],
        processedSignals: [], peakEquity: 100, mdd: 0 } }) } as Pick<ShadowStateStore, 'restore'>;
    const app = makeApp(shadowDbView(fakeMarket(), journal, activationId, () => at));
    try {
      expect((await app.inject('/api/market/status')).json()).toMatchObject({
        databaseSourceFresh: true, publicWsVerified: false, sourceFresh: false,
      });
      expect((await app.inject('/api/shadow/status')).json()).toMatchObject({
        activationRecorded: true, runtimeVerified: false, forwardShadowStarted: false,
        equity: 100, trades: 0, sourceFresh: false,
      });
      expect((await app.inject('/api/shadow/metrics')).json()).toMatchObject({
        status: 'RUNTIME_NOT_VERIFIED', totalTrades: 0, currentEquity: 100,
      });
      expect((await app.inject('/api/shadow/trades')).json()).toEqual([]);
      expect((await app.inject('/health')).json().status).toBe('not_ready');
    } finally { await app.close(); }
  });

  it('reports an absent activation without creating one', async () => {
    let reads = 0;
    const journal = { restore: async () => { reads++; return null; } } as Pick<ShadowStateStore, 'restore'>;
    const app = makeApp(shadowDbView(fakeMarket(), journal, activationId, () => at));
    try {
      expect((await app.inject('/api/shadow/status')).json()).toMatchObject({
        activationRecorded: false, forwardShadowStarted: false, equity: 100,
      });
      expect(reads).toBe(1);
    } finally { await app.close(); }
  });

  it('withholds current marked equity and derived metrics when the canonical source is stale', async () => {
    const market = fakeMarket();
    market.sourceState = async () => ({ latestTrade: at - 600_000,
      latestCandle: at - 600_000, latestCandleStatus: 'HEALTHY',
      health: 'HEALTHY', healthAt: at - 600_000 });
    const journal = { restore: async () => ({ activationId, lastSignalTimestamp: null,
      state: { activationAt: at - 300_000, balanceBtc: 0.001, open: null, closed: [],
        processedSignals: [], peakEquity: 100, mdd: 0 } }) } as Pick<ShadowStateStore, 'restore'>;
    const app = makeApp(shadowDbView(market, journal, activationId, () => at));
    try {
      expect((await app.inject('/api/shadow/status')).json()).toMatchObject({
        activationRecorded: true, databaseSourceFresh: false,
        forwardShadowStarted: false, equity: null,
      });
      expect((await app.inject('/api/shadow/metrics')).json()).toMatchObject({
        status: 'SOURCE_STALE', currentEquity: null, winRate: null,
      });
    } finally { await app.close(); }
  });
});
