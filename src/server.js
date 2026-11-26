// src/server.js
// Express app: POST /<repo>/run-agent (202), GET /<repo>/run-agent[/:id[/events]], GET /repos, GET /health,
// and the optional /admin dashboard. x-api-key auth on the API; the dashboard has its own auth (src/admin.js).
// Covers T2 (non-blocking submit), T4 (404), plus auth/validation.

import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateRunAgentBody, validateJobListQuery } from './lib/validate.js';
import { STATUS, TERMINAL_STATUSES } from './jobStore.js';

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
 * @property {{ apiKey: string, trustProxy?: boolean }} config   (full Config is fine). trustProxy: honour
 *           X-Forwarded-For/-Proto from a loopback/private-network proxy (req.ip, req.protocol)
 * @property {import('./jobStore.js').JobStore} store
 * @property {Pick<import('./worker.js').Worker, 'enqueue'>} worker
 * @property {Pick<import('./repoRegistry.js').RepoRegistry, 'get'|'has'|'list'>} repos
 * @property {(makeSse: (findJob: (req: import('express').Request) => any) => import('express').RequestHandler) => import('express').Router} [adminRouter]
 *           builds the /admin router given an SSE-handler factory; omitted = no /admin (dashboard disabled)
 * @property {{ info: Function, warn: Function, error: Function }} [logger=console]
 * @property {number} [sseHeartbeatMs=15000]   interval of the ": ping" comment that keeps proxies from idling out
 * @property {number} [sseMaxBufferedBytes=1048576]  a client whose socket buffer exceeds this is dropped (it can
 *                                              reconnect with Last-Event-ID) so a slow reader never grows memory
 */

/**
 * Build the express app (does NOT listen — tests call startServer(app, 0)).
 *
 * Every job endpoint names its repo in the path; <repo> is a repo id (repos are managed through the admin API).
 *
 *  - GET  /health                         -> 200 { ok: true }                (NO auth; liveness only, lists nothing)
 *  - /admin/...                           -> admin dashboard + API (own auth; only if deps.adminRouter)
 *  - GET  /repos                          -> 200 [{ id, default_branch }]   (x-api-key)
 *  - /<repo>/run-agent...                 (x-api-key checked first, then the repo: unknown -> 404 { error: 'repo not found' })
 *    - POST /<repo>/run-agent  { prompt, branch? }
 *          repo disabled -> 409 { error: 'repo disabled' }   (GETs on a disabled repo still work)
 *          v = validateRunAgentBody(req.body); !v.ok -> 400 { error }
 *          job = store.create({ prompt, branch: v.branch ?? repo.defaultBranch, repoId })
 *          worker.enqueue(job.id)      // synchronous; MUST NOT await the run (T2: < 1s)
 *          -> 202 { id, status }       // exactly these two keys, status === "queued"
 *    - GET  /<repo>/run-agent?status=&limit=&before=   -> 200 { jobs: JobSummary[], next: string|null }
 *    - GET  /<repo>/run-agent/:id      -> 200 store.toPublic(job); 404 { error: 'job not found' } if unknown OR the
 *                                         job belongs to another repo
 *    - GET  /<repo>/run-agent/:id/events   Server-Sent Events (see createSseHandler)
 *  - 404 fallthrough -> 404 { error: 'not found' }
 *  - error handler: invalid JSON -> 400, too large -> 413, otherwise 500 { error: 'internal error' }
 *
 * All error responses are JSON `{ error: string }`. app.closeStreams() ends every open SSE stream (shutdown).
 *
 * @param {AppDeps} deps
 * @returns {import('express').Express & { closeStreams: () => Promise<void> }}
 */
export function createApp(deps) {
  const { config, store, worker, repos } = deps;
  const logger = deps.logger ?? console;
  /** @type {Set<import('express').Response>} */
  const openStreams = new Set();
  /** SSE handlers share openStreams so closeStreams() ends all of them. */
  const makeSse = (findJob) => createSseHandler({
    store,
    openStreams,
    heartbeatMs: deps.sseHeartbeatMs ?? 15_000,
    maxBuffered: deps.sseMaxBufferedBytes ?? 1024 * 1024,
    findJob,
  });
  const sse = makeSse((req) => findRepoJob(store, req));
  const app = /** @type {any} */ (express());
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  if (deps.adminRouter) app.use('/admin', deps.adminRouter(makeSse));

  app.use(express.json({ limit: '1mb' }));
  const auth = apiKeyAuth(config.apiKey);

  app.get('/repos', auth, (_req, res) => {
    res.status(200).json(repos.list().map((r) => ({ id: r.id, default_branch: r.defaultBranch })));
  });

  const repoRouter = express.Router({ mergeParams: true });
  app.use('/:repo/run-agent', auth, (req, res, next) => {
    if (!repos.has(req.params.repo)) {
      res.status(404).json({ error: 'repo not found' });
      return;
    }
    next();
  }, repoRouter);

  repoRouter.post('/', (req, res) => {
    const repo = /** @type {any} */ (repos.get(req.params.repo)).config;
    if (repo.enabled === false) {
      res.status(409).json({ error: 'repo disabled' });
      return;
    }
    const v = validateRunAgentBody(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const job = store.create({ prompt: v.prompt, branch: v.branch ?? repo.defaultBranch, repoId: repo.id });
    worker.enqueue(job.id);
    res.status(202).json({ id: job.id, status: job.status });
  });

  repoRouter.get('/', (req, res) => {
    const q = validateJobListQuery(/** @type {any} */ (req.query), Object.values(STATUS));
    if (!q.ok) {
      res.status(400).json({ error: q.error });
      return;
    }
    const page = store.query({ repoId: req.params.repo, statuses: q.statuses, limit: q.limit, before: q.before });
    res.status(200).json({ jobs: page.jobs.map((j) => store.toSummary(j)), next: page.next });
  });

  repoRouter.get('/:id', (req, res) => {
    const job = findRepoJob(store, req);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.status(200).json(store.toPublic(job));
  });

  repoRouter.get('/:id/events', sse);

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

/** The job named by req.params.id, only if it belongs to req.params.repo. */
function findRepoJob(store, req) {
  const job = store.get(req.params.id);
  return job && job.repo_id === req.params.repo ? job : null;
}

/**
 * GET handler streaming one job's events as Server-Sent Events. Shared by /<repo>/run-agent/:id/events and the
 * admin dashboard. `findJob(req)` picks the job (null -> 404 JSON { error: 'job not found' }).
 *
 * 200 text/event-stream: replays buffered events with seq > Last-Event-ID (or ?since=), then streams live ones.
 * Frames: `id: <seq>\nevent: <type>\ndata: <json>`. If events were evicted from the ring, a `gap { dropped }`
 * event precedes the replay. The stream ends right after the terminal `result` event (or immediately after replay
 * if the job is already finished). `: ping` comments every heartbeatMs. Slow readers are dropped.
 *
 * @param {{ store: import('./jobStore.js').JobStore, openStreams: Set<import('express').Response>,
 *           heartbeatMs: number, maxBuffered: number,
 *           findJob: (req: import('express').Request) => import('./jobStore.js').Job|null|undefined }} o
 * @returns {import('express').RequestHandler}
 */
export function createSseHandler(o) {
  const { store, openStreams, heartbeatMs, maxBuffered, findJob } = o;
  return (req, res) => {
    const job = findJob(req);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    const id = job.id;
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
  };
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
