import type { FastifyInstance } from 'fastify';
export interface RuntimeView {
  health: () => unknown | Promise<unknown>; market: () => unknown | Promise<unknown>;
  shadow: () => unknown | Promise<unknown>; metrics: () => unknown | Promise<unknown>;
  trades: () => unknown[] | Promise<unknown[]>;
}
export function registerHealth(app: FastifyInstance, view: RuntimeView): void {
  app.get('/health', async () => view.health());
  app.get('/api/market/status', async () => view.market());
  app.get('/api/shadow/status', async () => view.shadow());
  app.get('/api/shadow/metrics', async () => view.metrics());
  app.get('/api/shadow/trades', async () => view.trades());
}
