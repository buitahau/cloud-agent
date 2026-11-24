// src/server.js
// Express app: POST /run-agent (202), GET /run-agent/:id (200/404), GET /health. x-api-key auth.
// Covers T2 (non-blocking submit), T4 (404), plus auth/validation.

import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateRunAgentBody } from './lib/validate.js';

/**
 * @typedef {Object} AppDeps
 * @property {{ repoBranch: string, apiKey: string }} config   (full Config is fine)
 * @property {import('./jobStore.js').JobStore} store
 * @property {Pick<import('./worker.js').Worker, 'enqueue'>} worker
 * @property {{ info: Function, warn: Function, error: Function }} [logger=console]
 */

/**
 * Build the express app (does NOT listen — tests call startServer(app, 0)).
 *
 * Middleware / routes, in order:
 *  - app.disable('x-powered-by')
 *  - express.json({ limit: '1mb' })
 *  - GET  /health                -> 200 { ok: true }                         (NO auth; for liveness checks)
 *  - apiKeyAuth(config.apiKey) mounted on '/run-agent'
 *  - POST /run-agent
 *        v = validateRunAgentBody(req.body); !v.ok -> 400 { error: v.error }
 *        job = store.create({ prompt: v.prompt, branch: v.branch ?? config.repoBranch })
 *        worker.enqueue(job.id)       // synchronous; MUST NOT await the run (T2: < 1s)
 *        -> 202 { id: job.id, status: job.status }      // exactly these two keys, status === "queued"
 *  - GET  /run-agent/:id
 *        job = store.get(req.params.id); !job -> 404 { error: 'job not found' }
 *        -> 200 store.toPublic(job)
 *  - 404 fallthrough               -> 404 { error: 'not found' }
 *  - error handler (4 args):
 *        err.type === 'entity.parse.failed'   -> 400 { error: 'invalid JSON body' }
 *        err.type === 'entity.too.large'      -> 413 { error: 'body too large' }
 *        otherwise logger.error(err)          -> 500 { error: 'internal error' }
 *
 * All error responses are JSON `{ error: string }`.
 *
 * @param {AppDeps} deps
 * @returns {import('express').Express}
 */
export function createApp(deps) {
  const { config, store, worker } = deps;
  const logger = deps.logger ?? console;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/run-agent', apiKeyAuth(config.apiKey));

  app.post('/run-agent', (req, res) => {
    const v = validateRunAgentBody(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const job = store.create({ prompt: v.prompt, branch: v.branch ?? config.repoBranch });
    worker.enqueue(job.id);
    res.status(202).json({ id: job.id, status: job.status });
  });

  app.get('/run-agent/:id', (req, res) => {
    const job = store.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.status(200).json(store.toPublic(job));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'body too large' });
      return;
    }
    logger.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

/**
 * Middleware: require header `x-api-key` equal to expectedKey.
 * Compare in constant time: hash both with sha256 and timingSafeEqual the digests (handles length mismatch).
 * Missing or wrong -> 401 { error: 'unauthorized' }.
 * @param {string} expectedKey
 * @returns {import('express').RequestHandler}
 */
export function apiKeyAuth(expectedKey) {
  const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest();
  const expected = sha(expectedKey);
  return (req, res, next) => {
    const given = req.get('x-api-key');
    if (typeof given !== 'string' || given.length === 0 || !timingSafeEqual(sha(given), expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Listen on port (0 = ephemeral). Resolves with the http.Server once listening; rejects on 'error'
 * (e.g. EADDRINUSE). Callers read the real port from server.address().port.
 * @param {import('express').Express} app
 * @param {number} port
 * @param {string} [host]  default undefined (all interfaces)
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}
