// src/admin.js
// Admin dashboard: React single-page app (built from web/ into web/dist by `npm run build:web`) + JSON API under
// /admin/api, behind HTTP Basic auth with its own credentials (ADMIN_USER / ADMIN_PASSWORD). Not mounted at all when
// ADMIN_PASSWORD is unset.
//
// Basic auth is used because the browser shows its own prompt and resends the credentials automatically on
// same-origin requests — including EventSource, so the live job view needs no fetch-stream workaround.
// GET routes are read-only. Writes (POST/PATCH/PUT/DELETE under /admin/api/repos) — in fact every non-GET/HEAD
// request under /admin — must pass the CSRF checks in src/lib/csrf.js (application/json + X-Admin-Request: 1 +
// same-origin Origin/Sec-Fetch-Site), because browsers attach Basic credentials automatically. basicAuth runs
// first (cross-site requests without credentials still get 401) and bodies are parsed only after the CSRF check.
//
// CSP vs CSRF: `form-action 'none'` and `default-src 'self'` (which also sets connect-src) only restrict OUR pages
// (no form posts, no fetches to other origins); they do nothing against another site targeting us — that is what
// csrf.js is for. A form can't send custom headers or application/json; a cross-origin fetch with them triggers a
// preflight, which we never answer with Access-Control-Allow-*, so the real request is never sent.
// XSS: script injected into our origin would pass CSRF; that is mitigated by script-src 'self' (no unsafe-inline)
// and the "no innerHTML" test. Keep the CSP unchanged. ADMIN_PASSWORD is a write credential.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { STATUS } from './jobStore.js';
import { isValidRepoId, validateJobListQuery, MAX_LIST_LIMIT } from './lib/validate.js';
import { csrfGuard } from './lib/csrf.js';
import { RepoMutationError } from './repoRegistry.js';

const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

/**
 * @param {Object} deps
 * @param {{ adminUser: string, adminPassword: string, trustProxy?: boolean, maxConcurrentJobs?: number }} deps.config
 * @param {import('./jobStore.js').JobStore} deps.store
 * @param {Pick<import('./worker.js').Worker, 'stats'|'queueLength'|'poke'>} deps.worker
 * @param {import('./repoRegistry.js').RepoRegistry} deps.repos
 * @param {boolean} [deps.persistence=false]   whether JOBS_FILE is on (shown on the overview)
 * @param {() => number} [deps.now]            ms clock (tests)
 * @param {string} [deps.publicDir]            built SPA directory (default web/dist)
 * @returns {(makeSse: (findJob: (req: import('express').Request) => any) => import('express').RequestHandler) => import('express').Router}
 */
export function createAdminRouter(deps) {
  const { config, store, worker, repos } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  return (makeSse) => {
    const sse = makeSse((req) => store.get(req.params.id));
    const router = express.Router();
    router.use(securityHeaders);
    router.use(basicAuth(config.adminUser, config.adminPassword));
    router.use(csrfGuard({ trustProxy: Boolean(config.trustProxy) })); // every non-GET/HEAD admin request

    // ---- JSON API ----
    const api = express.Router();
    api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    api.use(express.json({ limit: '64kb' }));

    api.get('/summary', (_req, res) => {
      const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
      const last24h = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
      const since = now() - 24 * 3600 * 1000;
      for (const j of store.list()) {
        counts[j.status]++;
        if (Date.parse(j.created_at) >= since) last24h[j.status]++;
      }
      const stats = worker.stats();
      res.json({
        uptime_s: Math.round((now() - startedAt) / 1000),
        max_concurrent: stats.maxConcurrent,
        queued: stats.queued,
        running: stats.running.map((r) => ({ job_id: r.jobId, repo_id: r.repoId })),
        counts,
        last_24h: last24h,
        repos: repos.ids().length,
        persistence: Boolean(deps.persistence),
      });
    });

    api.get('/repos', (_req, res) => {
      res.json(repos.ids().map((id) => repos.status(id, store, worker)));
    });

    api.get('/repos/:id', (req, res) => {
      const st = isValidRepoId(req.params.id) ? repos.status(req.params.id, store, worker) : null;
      if (!st) {
        res.status(404).json({ error: 'repo not found' });
        return;
      }
      const recent = store.query({ repoId: req.params.id, limit: 20 }).jobs.map((j) => store.toSummary(j));
      res.json({ ...st, recent_jobs: recent });
    });

    api.get('/jobs', (req, res) => {
      const q = validateJobListQuery(/** @type {any} */ (req.query), Object.values(STATUS));
      if (!q.ok) {
        res.status(400).json({ error: q.error });
        return;
      }
      let repoId = null;
      // Any valid id, so a deleted repo's job history can still be filtered.
      if (typeof req.query.repo === 'string' && req.query.repo !== '') {
        if (!isValidRepoId(req.query.repo)) {
          res.status(400).json({ error: 'repo must be a valid repo id' });
          return;
        }
        repoId = req.query.repo;
      }
      const page = store.query({ repoId, statuses: q.statuses, limit: q.limit, before: q.before });
      res.json({ jobs: page.jobs.map((j) => store.toSummary(j)), next: page.next });
    });

    api.get('/jobs/:id', (req, res) => {
      const job = store.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      const events = store.readEvents(job.id);
      res.json({
        ...store.toPublic(job),
        history: job.history.map((h) => ({ ...h })),
        log: store.readLog(job.id) ?? [],
        events_buffered: events ? events.events.length : 0,
      });
    });

    api.get('/jobs/:id/events', (req, res, next) => {
      res.removeHeader('Cache-Control'); // SSE sets its own
      next();
    }, sse);

    // ---- repo writes (CSRF-checked above) ----
    /** @param {import('express').Request} req @returns {import('./repoRegistry.js').MutationContext} */
    const ctx = (req) => ({ actor: config.adminUser, ip: req.ip ?? null });
    /** RepoMutationError -> its status + { error, problems? }; anything else -> the app error handler. */
    const fail = (err, res, next) => {
      if (!(err instanceof RepoMutationError)) { next(err); return; }
      res.status(err.status).json(err.problems ? { error: err.message, problems: err.problems } : { error: err.message });
    };

    api.post('/repos', (req, res, next) => {
      try {
        const c = repos.create(req.body, ctx(req));
        res.status(201).json(repos.status(c.id, store, worker));
      } catch (err) { fail(err, res, next); }
    });

    api.patch('/repos/:id', (req, res, next) => {
      try {
        repos.update(req.params.id, req.body, ctx(req));
        worker.poke(); // a disabled repo's queued jobs fail right away
        res.json(repos.status(req.params.id, store, worker));
      } catch (err) { fail(err, res, next); }
    });

    api.put('/repos/:id/token', (req, res, next) => {
      try {
        const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        repos.setToken(req.params.id, body.token, ctx(req));
        res.status(204).end();
      } catch (err) { fail(err, res, next); }
    });

    api.delete('/repos/:id', (req, res, next) => {
      try {
        repos.remove(req.params.id, ctx(req));
        res.status(204).end();
      } catch (err) { fail(err, res, next); }
    });

    api.get('/audit', (req, res) => {
      const q = validateAuditQuery(/** @type {any} */ (req.query));
      if (!q.ok) {
        res.status(400).json({ error: q.error });
        return;
      }
      res.json(repos.listAudit({ repoId: q.repoId, limit: q.limit, before: q.before }));
    });

    api.use((_req, res) => { res.status(404).json({ error: 'not found' }); });

    router.use('/api', api);
    mountSpa(router, deps.publicDir ?? DEFAULT_PUBLIC_DIR);
    router.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
    return router;
  };
}

/**
 * ?repo=&limit=&before= of GET /admin/api/audit. repo = any valid id (deleted repos included), before = audit id
 * (exclusive cursor).
 * @param {Record<string, unknown>} query
 * @returns {{ ok: true, repoId: string|null, limit: number, before: number|null } | { ok: false, error: string }}
 */
export function validateAuditQuery(query) {
  const q = query ?? {};
  let repoId = null;
  if (q.repo !== undefined && q.repo !== '') {
    if (!isValidRepoId(q.repo)) return { ok: false, error: 'repo must be a valid repo id' };
    repoId = /** @type {string} */ (q.repo);
  }
  let limit = 50;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
      return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` };
    }
    limit = n;
  }
  let before = null;
  if (q.before !== undefined && q.before !== '') {
    if (typeof q.before !== 'string' || !/^[1-9]\d{0,15}$/.test(q.before)) return { ok: false, error: 'before must be an audit entry id' };
    before = Number(q.before);
  }
  return { ok: true, repoId, limit, before };
}

/**
 * Serve the built SPA: hashed /assets cached forever, index.html never cached, and every extension-less GET
 * (client-side routes like /admin/jobs/<id>) falls back to index.html. Missing files with an extension -> 404.
 * If the app was never built, page requests get a 503 that says how to build it.
 * @param {import('express').Router} router
 * @param {string} dir
 */
function mountSpa(router, dir) {
  const index = path.join(dir, 'index.html');
  const built = fs.existsSync(index);
  router.use('/assets', express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
  router.use(express.static(dir, { index: false, maxAge: 0 }));
  router.get('*', (req, res, next) => {
    if (path.extname(req.path)) { next(); return; }
    if (!built) {
      res.status(503).type('text/plain').send('admin dashboard not built: run `npm run build:web`\n');
      return;
    }
    res.sendFile(index, { headers: { 'Cache-Control': 'no-cache' } });
  });
}

/** @type {import('express').RequestHandler} */
function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
}

/**
 * HTTP Basic auth, constant-time (sha256 + timingSafeEqual over "user:password").
 * Missing/wrong -> 401 { error: 'unauthorized' } + WWW-Authenticate so the browser prompts.
 * @param {string} user
 * @param {string} password
 * @returns {import('express').RequestHandler}
 */
export function basicAuth(user, password) {
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest();
  const expected = sha(`${user}:${password}`);
  return (req, res, next) => {
    const h = req.get('authorization') ?? '';
    const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(h.trim());
    const given = m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
    if (given === null || !timingSafeEqual(sha(given), expected)) {
      res.set('WWW-Authenticate', 'Basic realm="cloud-agent admin", charset="UTF-8"');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
