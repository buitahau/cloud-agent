// src/server.js
// Express app: POST /run-agent (202), GET /run-agent/:id (200/404), GET /run-agent/:id/events (SSE), GET /health.
// x-api-key auth.
// Covers T2 (non-blocking submit), T4 (404), plus auth/validation.

import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateRunAgentBody } from './lib/validate.js';
import { TERMINAL_STATUSES } from './jobStore.js';

/**
 * One SSE frame. JSON.stringify never emits raw newlines, so a single `data:` line is always valid.
 * `id:` is omitted for synthetic events (gap) so Last-Event-ID keeps pointing at the last real event.
 * @param {{ seq?: number, type: string, data: object }} evt
 * @returns {string}
 */
export function formatSse(evt) {
  const id = evt.seq === undefined ? '' : `id: ${evt.seq}\n`;
  return `${id}event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`;
}

/**
 * @typedef {Object} AppDeps
 * @property {{ repoBranch: string, apiKey: string }} config   (full Config is fine)
 * @property {import('./jobStore.js').JobStore} store
 * @property {Pick<import('./worker.js').Worker, 'enqueue'>} worker
 * @property {{ info: Function, warn: Function, error: Function }} [logger=console]
 * @property {number} [sseHeartbeatMs=15000]   interval of the ": ping" comment that keeps proxies from idling out
 * @property {number} [sseMaxBufferedBytes=1048576]  a client whose socket buffer exceeds this is dropped (it can
 *                                              reconnect with Last-Event-ID) so a slow reader never grows memory
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
 *  - GET  /run-agent/:id/events  (Server-Sent Events; same x-api-key auth — browsers' EventSource cannot send
 *        headers, so use fetch() with a streaming reader, or @microsoft/fetch-event-source)
 *        unknown id -> 404 JSON. Otherwise 200 text/event-stream: replays buffered events with seq >
 *        Last-Event-ID (or ?since=), then streams live ones. Frames: `id: <seq>\nevent: <type>\ndata: <json>`.
 *        If events were evicted from the ring, a `gap { dropped }` event precedes the replay.
 *        The stream ends right after the terminal `result` event (or immediately after replay if the job is
 *        already finished). `: ping` comments every sseHeartbeatMs.
 *        app.closeStreams() ends every open stream (graceful shutdown).
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
  const heartbeatMs = deps.sseHeartbeatMs ?? 15_000;
  const maxBuffered = deps.sseMaxBufferedBytes ?? 1024 * 1024;
  /** @type {Set<import('express').Response>} */
  const openStreams = new Set();
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

  app.get('/run-agent/:id/events', (req, res) => {
    const id = req.params.id;
    const job = store.get(id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    const rawLast = req.get('last-event-id') ?? (typeof req.query.since === 'string' ? req.query.since : '0');
    const lastSeq = Number.parseInt(rawLast, 10);
    const after = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0;

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    openStreams.add(res);

    let unsubscribe = null;
    let heartbeat = null;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      openStreams.delete(res);
    };
    const finish = () => { cleanup(); if (!res.writableEnded) res.end(); };
    const send = (evt) => {
      if (done) return;
      res.write(formatSse(evt));
      if (evt.type === 'result') { finish(); return; }
      if (res.writableLength > maxBuffered) finish(); // slow reader: drop; it resumes via Last-Event-ID
    };
    res.on('close', cleanup);

    // Subscribe BEFORE replay; both are synchronous so no event can slip between them.
    unsubscribe = store.subscribe(id, send);
    const replay = store.readEvents(id, after);
    if (replay) {
      if (replay.dropped > 0) res.write(formatSse({ type: 'gap', data: { dropped: replay.dropped } }));
      for (const evt of replay.events) send(evt);
    }
    if (done) return;
    if (TERMINAL_STATUSES.has(job.status)) { finish(); return; } // result event was evicted/never replayed
    heartbeat = setInterval(() => { if (!done) res.write(': ping\n\n'); }, heartbeatMs);
    heartbeat.unref?.();
  });

  /** End every open SSE stream (called on shutdown so server.close() isn't held open). */
  app.closeStreams = () => {
    const pending = [...openStreams].map((res) => new Promise((resolve) => {
      res.once('close', resolve);
      res.end();
      setTimeout(resolve, 1000).unref?.();
    }));
    return Promise.all(pending).then(() => undefined);
  };

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
