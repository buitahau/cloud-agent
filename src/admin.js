// src/admin.js
// Read-only admin dashboard: React single-page app (built from web/ into web/dist by `npm run build:web`) + JSON API
// under /admin/api, behind HTTP Basic auth with its own credentials (ADMIN_USER / ADMIN_PASSWORD). Not mounted at
// all when ADMIN_PASSWORD is unset.
//
// Basic auth is used because the browser shows its own prompt and resends the credentials automatically on
// same-origin requests — including EventSource, so the live job view needs no fetch-stream workaround.
// Everything here is GET-only. Any future state-changing action must add CSRF checks (Origin / custom header),
// because browsers attach Basic credentials automatically.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { STATUS } from './jobStore.js';
import { isValidRepoId, validateJobListQuery } from './lib/validate.js';

const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

/**
 * @param {Object} deps
 * @param {{ adminUser: string, adminPassword: string, maxConcurrentJobs?: number }} deps.config
 * @param {import('./jobStore.js').JobStore} deps.store
 * @param {Pick<import('./worker.js').Worker, 'stats'|'queueLength'>} deps.worker
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

    // ---- JSON API ----
    const api = express.Router();
    api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

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
      if (typeof req.query.repo === 'string' && req.query.repo !== '') {
        if (!repos.has(req.query.repo)) {
          res.status(400).json({ error: 'unknown repo' });
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

    api.use((_req, res) => { res.status(404).json({ error: 'not found' }); });

    router.use('/api', api);
    mountSpa(router, deps.publicDir ?? DEFAULT_PUBLIC_DIR);
    router.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
    return router;
  };
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
