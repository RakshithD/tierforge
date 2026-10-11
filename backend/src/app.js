// Express app factory: wires CORS, JSON parsing, health check, API docs, /api routes and error handling.

import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { apiRoutes } from './routes/index.js';
import { docsRoutes } from './routes/docs.routes.js';

// Build the Express app. The pool is injected so tests can use their own database.
export function createApp(pool) {
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  // Liveness probe, plus docs (/docs, /openapi.json) and the REST API; 404 and error handlers must come last.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(docsRoutes());
  app.use('/api', apiRoutes(pool));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
