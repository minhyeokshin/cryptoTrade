import Fastify from 'fastify';
import { registerHealth, type RuntimeView } from './api/routes/health.js';

export function makeApp(view: RuntimeView) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  registerHealth(app, view);
  return app;
}
