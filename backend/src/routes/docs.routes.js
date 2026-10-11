// API documentation routes: serves the OpenAPI spec and Swagger UI.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

// openapi.yaml lives in src/, one level above routes/.
const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi.yaml');

/** Swagger UI at /docs and the raw spec at /openapi.json. */
export function docsRoutes() {
  const spec = parse(readFileSync(specPath, 'utf8'));
  const router = Router();
  router.get('/openapi.json', (_req, res) => res.json(spec));
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  return router;
}
