import type { FastifyInstance } from 'fastify';
export interface RuntimeView {
  market: () => unknown; shadow: () => unknown; metrics: () => unknown; trades: () => unknown[];
}
export function registerHealth(app: FastifyInstance, view: RuntimeView): void {
  app.get('/health', async () => ({ status: 'not_ready', components: {
    process: 'up', database: 'not_verified', bybitWs: 'not_verified', sourceFresh: false,
    inference: 'not_verified', shadowEngine: 'not_started', hourlyReport: 'not_started' } }));
  app.get('/api/market/status', async () => view.market());
  app.get('/api/shadow/status', async () => view.shadow());
  app.get('/api/shadow/metrics', async () => view.metrics());
  app.get('/api/shadow/trades', async () => view.trades());
}
