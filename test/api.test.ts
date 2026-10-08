import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.js';

describe('read-only operational API', () => {
  it('exposes health, market and zero-trade Shadow state without initializing exchange clients', async () => {
    const app = makeApp({
      health: () => ({ status: 'not_ready', components: { bybitWs: 'connected', sourceFresh: true } }),
      market: () => ({ connected: true, sourceFresh: true, historicalSourceGap: 'OPEN' }),
      shadow: () => ({ forwardShadowStarted: false, equity: 100, trades: 0 }),
      metrics: () => ({ totalTrades: 0, winRate: null }),
      trades: () => [],
    });
    try {
      expect((await app.inject('/health')).json().components.bybitWs).toBe('connected');
      expect((await app.inject('/api/market/status')).json().historicalSourceGap).toBe('OPEN');
      expect((await app.inject('/api/shadow/status')).json().forwardShadowStarted).toBe(false);
      expect((await app.inject('/api/shadow/metrics')).json().totalTrades).toBe(0);
      expect((await app.inject('/api/shadow/trades')).json()).toEqual([]);
    } finally { await app.close(); }
  });
});
