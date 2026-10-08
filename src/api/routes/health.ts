import type { FastifyInstance } from 'fastify';
export interface RuntimeView {
  health: () => unknown; market: () => unknown; shadow: () => unknown;
  metrics: () => unknown; trades: () => unknown[];
}
export function registerHealth(app: FastifyInstance, view: RuntimeView): void {
  app.get('/health', async () => view.health());
  app.get('/api/market/status', async () => view.market());
  app.get('/api/shadow/status', async () => view.shadow());
  app.get('/api/shadow/metrics', async () => view.metrics());
  app.get('/api/shadow/trades', async () => view.trades());
}
