// src/repoRegistry.js
// The repos (loaded from the database at startup) with one GitSync each, plus repo health derived from job
// history. Tokens are never held here: each GitSync reads its repo's token from the store per sync.
// Mutable at runtime through the admin API: each mutation = DB write + audit row in one store.tx, then the
// in-memory entry is swapped. A running job keeps its snapshot (worker.js start()); a queued job uses the entry
// current when it's picked.
//
// No race between a mutation and the worker: every mutation is fully synchronous (the 409 checks, the DB
// transaction on DatabaseSync, the Map swap and fs.rmSync all run in one JS turn). The worker's pump() also runs
// synchronously inside a setImmediate callback, and processJob only yields at `await gitSync.sync` and
// `await claudeRunner.run`. start() defers processJob by one microtask, so for that window a picked job is still
// "queued" in the store; but microtasks drain before any I/O callback and an HTTP handler is an I/O callback, so
// a handler always sees "pulling" or later. remove() counts every non-terminal job anyway.

import fs from 'node:fs';
import path from 'node:path';
import { createGitSync, normalizeRemote } from './gitSync.js';
import { STATUS, TERMINAL_STATUSES } from './jobStore.js';
import { validateRepoInput, validateToken } from './lib/repoValidate.js';
import { validateRepoUrl } from './lib/validate.js';
import { originOf } from './secrets.js';

/** A rejected admin mutation; admin.js maps `status` to the HTTP status. Messages never contain token values. */
export class RepoMutationError extends Error {
  /** @param {400|404|409} status @param {string} message @param {string[]} [problems] */
  constructor(status, message, problems) {
    super(message);
    this.name = 'RepoMutationError';
    this.status = status;
    if (problems) this.problems = problems;
  }
}

/** @typedef {{ actor: string, ip?: string|null }} MutationContext */

/**
 * One target repository (a repos row plus its workspace). No token field.
 * @typedef {Object} RepoConfig
 * @property {string}      id             url-safe id, used in routes (/<id>/run-agent) and as the workspace dir name
 * @property {string}      url            git remote URL
 * @property {'https'|'ssh'|'local'} kind
 * @property {string}      defaultBranch  branch used when a job does not name one
 * @property {string|null} sshKeyPath     absolute (ssh URLs only)
 * @property {boolean}     enabled
 * @property {string}      workspaceDir   ABSOLUTE: <workspaceRoot>/<id>
 */

/**
 * @typedef {Object} RepoEntry
 * @property {RepoConfig} config
 * @property {import('./gitSync.js').GitSync} gitSync
 * @property {string} workspaceDir
 */

/**
 * @typedef {'ok'|'syncing'|'sync_error'|'never_synced'} RepoHealth
 */

/**
 * @typedef {Object} RepoStatus
 * @property {string} id
 * @property {string} url_display
 * @property {string} default_branch
 * @property {string} workspace_dir
 * @property {boolean} cloned
 * @property {RepoHealth} health
 * @property {{ at: string, ok: boolean, branch: string, commit: string|null, duration_ms: number|null, error: string|null, job_id: string }|null} last_sync
 * @property {Record<string, number>} counts   jobs per status (jobs still in memory)
 * @property {string|null} running_job_id
 * @property {number} queued
 * @property {boolean} enabled
 * @property {{ kind: 'https'|'ssh'|'local', token: { set: true, hint: string, updated_at: string }|null, ssh_key_path: string|null }} auth
 * @property {{ id: string, status: string, created_at: string, finished_at: string|null }|null} last_job
 */

/**
 * @param {{ repoStore: import('./repoStore.js').RepoStore, jobs?: Pick<import('./jobStore.js').JobStore, 'list'>,
 *           workspaceRoot: string, gitTimeoutMs: number, secretEnvNames?: string[], gitSyncFactory?: typeof createGitSync,
 *           allowLocal?: boolean, sshKeysDir?: string|null,
 *           log?: { info: (m: string) => void, error: (m: string) => void } }} opts
 *   Read-only callers (tests) may pass a repoStore with only list/getToken/tokenInfo.
 */
export function createRepoRegistry(opts) {
  const factory = opts.gitSyncFactory ?? createGitSync;
  const repoStore = opts.repoStore;
  const jobs = opts.jobs ?? { list: () => [] };
  const log = opts.log ?? { info: (m) => console.log(m), error: (m) => console.error(m) };
  const rules = { allowLocal: opts.allowLocal ?? false, sshKeysDir: opts.sshKeysDir ?? null };

  /** @param {import('./repoStore.js').RepoRecord} rec @returns {RepoEntry} */
  function buildEntry(rec) {
    const workspaceDir = path.join(opts.workspaceRoot, rec.id);
    /** @type {RepoConfig} */
    const config = Object.freeze({
      id: rec.id,
      url: rec.url,
      kind: rec.kind,
      defaultBranch: rec.defaultBranch,
      sshKeyPath: rec.sshKeyPath ?? null,
      enabled: rec.enabled !== false,
      workspaceDir,
    });
    return {
      config,
      workspaceDir,
      gitSync: factory({
        repoUrl: rec.url,
        workspaceDir,
        sshKeyPath: config.sshKeyPath,
        getToken: () => repoStore.getToken(rec.id),
        timeoutMs: opts.gitTimeoutMs,
        secretEnvNames: opts.secretEnvNames ?? [],
      }),
    };
  }

  /** @type {Map<string, RepoEntry>} */
  const entries = new Map();
  for (const rec of repoStore.list()) entries.set(rec.id, buildEntry(rec));

  const CREATE_FIELDS = new Set(['id', 'url', 'defaultBranch', 'sshKeyPath', 'token']);
  const UPDATE_FIELDS = new Set(['url', 'defaultBranch', 'sshKeyPath', 'enabled', 'token']);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const given = (v) => v !== undefined && v !== null;
  const tokenNote = (hint) => (hint ? `set …${hint}` : 'set');
  const sameOrigin = (a, b) => { try { return originOf(a) === originOf(b); } catch { return false; } };

  /** @param {unknown} id @returns {RepoEntry} */
  const mustGet = (id) => {
    const e = typeof id === 'string' ? entries.get(id) : undefined;
    if (!e) throw new RepoMutationError(404, 'repo not found');
    return e;
  };
  /** @param {unknown} body @param {Set<string>} allowed */
  const checkBody = (body, allowed) => {
    if (!isObj(body)) throw new RepoMutationError(400, 'body must be a JSON object');
    const bad = Object.keys(/** @type {object} */ (body)).filter((k) => !allowed.has(k));
    if (bad.length) throw new RepoMutationError(400, `unknown field${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`);
  };
  /** @param {string[]} problems */
  const invalid = (problems) => new RepoMutationError(400, problems.join('; '), problems);
  /** @param {unknown} t @returns {string} */
  const checkToken = (t) => {
    const v = validateToken(t);
    if (!v.ok) throw new RepoMutationError(400, v.error);
    return v.token;
  };
  /** Non-terminal jobs of a repo: queued vs pulling/running. @param {string} id */
  const activity = (id) => {
    let queued = 0;
    let running = 0;
    for (const j of jobs.list()) {
      if (j.repo_id !== id || TERMINAL_STATUSES.has(j.status)) continue;
      if (j.status === STATUS.QUEUED) queued++;
      else running++;
    }
    return { queued, running };
  };
  /** @param {MutationContext} ctx @param {string} action @param {string} repoId @param {object} details  never secrets */
  const audit = (ctx, action, repoId, details) =>
    repoStore.insertAudit({ actor: ctx.actor, ip: ctx.ip ?? null, action, repoId, details });
  /** Log line after commit. @param {MutationContext} ctx @param {string} action @param {string} repoId @param {object} details */
  const announce = (ctx, action, repoId, details) =>
    log.info(`[audit] ${ctx.actor}${ctx.ip ? ` (${ctx.ip})` : ''} ${action} ${repoId} ${JSON.stringify(details)}`);
  /** @param {string} dir */
  const wipe = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.error(`[repos] could not delete workspace ${dir}: ${err?.message ?? err}`);
    }
  };
  /** Rebuild the entry from the (committed) row. @param {string} id */
  const swap = (id) => {
    const e = buildEntry(/** @type {import('./repoStore.js').RepoRecord} */ (repoStore.get(id)));
    entries.set(id, e);
    return e;
  };

  /** @param {string} id @param {unknown} enabled @param {MutationContext} ctx @returns {RepoConfig} */
  function setEnabled(id, enabled, ctx) {
    const e = mustGet(id);
    if (typeof enabled !== 'boolean') throw new RepoMutationError(400, 'enabled must be true or false');
    if (e.config.enabled === enabled) return e.config;
    const action = enabled ? 'repo.enable' : 'repo.disable';
    const details = { enabled: { from: e.config.enabled, to: enabled } };
    repoStore.tx(() => {
      repoStore.setEnabled(id, enabled);
      audit(ctx, action, id, details);
    });
    const ne = swap(id);
    announce(ctx, action, id, details);
    return ne.config;
  }

  return {
    /** @param {string} id @returns {RepoEntry|undefined} */
    get: (id) => entries.get(id),
    /** @param {string} id */
    has: (id) => entries.has(id),
    ids: () => [...entries.keys()],
    /** @returns {RepoConfig[]} */
    list: () => [...entries.values()].map((e) => e.config),

    /**
     * Add a repo (https needs a token). Does not wipe a leftover <workspaceRoot>/<id> dir: gitSync refuses a
     * clone of another remote with an actionable message.
     * @param {unknown} input  { id, url, defaultBranch?, sshKeyPath?, token? }
     * @param {MutationContext} ctx
     * @returns {RepoConfig}
     * @throws {RepoMutationError}
     */
    create(input, ctx) {
      checkBody(input, CREATE_FIELDS);
      const body = /** @type {Record<string, any>} */ (input);
      const v = validateRepoInput(body, rules); // checkKeyFile: true (default)
      if (!v.ok) throw invalid(v.problems);
      const repo = v.repo;
      if (entries.has(repo.id) || repoStore.get(repo.id)) throw new RepoMutationError(409, `repo "${repo.id}" already exists`);
      let token = null;
      if (repo.kind === 'https') {
        if (!given(body.token)) throw new RepoMutationError(400, 'https repos need a token');
        token = checkToken(body.token);
      } else if (given(body.token)) {
        throw new RepoMutationError(400, 'token only applies to https URLs');
      }
      /** @type {Record<string, unknown>} */
      const details = { url: repo.url, kind: repo.kind, defaultBranch: repo.defaultBranch, sshKeyPath: repo.sshKeyPath };
      repoStore.tx(() => {
        repoStore.insertRepo(repo);
        if (token !== null) details.token = tokenNote(repoStore.setToken(repo.id, token).hint);
        audit(ctx, 'repo.create', repo.id, details);
      });
      const e = swap(repo.id);
      announce(ctx, 'repo.create', repo.id, details);
      return e.config;
    },

    /**
     * Partial update. A URL change is refused (409) while a job of the repo is pulling/running; a different remote
     * wipes the workspace after the commit. Moving to another https origin (or to https from ssh/local) needs
     * `token` in the same patch because the stored token is bound to the old origin; leaving https drops it.
     * @param {string} id
     * @param {unknown} patch  { url?, defaultBranch?, sshKeyPath?, enabled?, token? }
     * @param {MutationContext} ctx
     * @returns {RepoConfig}
     * @throws {RepoMutationError}
     */
    update(id, patch, ctx) {
      const e = mustGet(id);
      checkBody(patch, UPDATE_FIELDS);
      const p = /** @type {Record<string, any>} */ (patch);
      const keys = Object.keys(p);
      if (!keys.length) throw new RepoMutationError(400, 'nothing to update');
      if ('enabled' in p && typeof p.enabled !== 'boolean') throw new RepoMutationError(400, 'enabled must be true or false');
      if (keys.length === 1 && keys[0] === 'enabled') return setEnabled(id, p.enabled, ctx);
      const cur = e.config;
      const url = 'url' in p ? p.url : cur.url;
      const urlChanged = url !== cur.url;
      // Switching away from ssh clears the key path unless the patch says otherwise.
      let sshKeyPath = 'sshKeyPath' in p ? p.sshKeyPath : cur.sshKeyPath;
      if (!('sshKeyPath' in p) && urlChanged) {
        const u = validateRepoUrl(url);
        if (u.ok && u.kind !== 'ssh') sshKeyPath = null;
      }
      const v = validateRepoInput(
        { id, url, defaultBranch: 'defaultBranch' in p ? p.defaultBranch : cur.defaultBranch, sshKeyPath },
        { ...rules, checkKeyFile: given(p.sshKeyPath) },
      );
      if (!v.ok) throw invalid(v.problems);
      const next = v.repo;
      const hadToken = cur.kind === 'https' && repoStore.tokenInfo(id) !== null;
      const dropToken = hadToken && (next.kind !== 'https' || !sameOrigin(next.url, cur.url));
      if (given(p.token) && next.kind !== 'https') throw new RepoMutationError(400, 'token only applies to https URLs');
      const token = given(p.token) ? checkToken(p.token) : null;
      if (urlChanged && next.kind === 'https' && (!hadToken || dropToken) && token === null) {
        throw new RepoMutationError(400, 'token is required: the stored token only works for the old host (or there is none)');
      }
      if (urlChanged && activity(id).running > 0) {
        throw new RepoMutationError(409, 'repo has a running job; wait for it to finish before changing the URL');
      }
      const enabled = 'enabled' in p ? p.enabled : cur.enabled;
      /** @type {Record<string, unknown>} */
      const details = {};
      for (const [k, from, to] of /** @type {Array<[string, unknown, unknown]>} */ ([
        ['url', cur.url, next.url],
        ['defaultBranch', cur.defaultBranch, next.defaultBranch],
        ['sshKeyPath', cur.sshKeyPath, next.sshKeyPath],
        ['enabled', cur.enabled, enabled],
      ])) {
        if (from !== to) details[k] = { from, to };
      }
      const wipeWorkspace = urlChanged && normalizeRemote(next.url) !== normalizeRemote(cur.url);
      if (wipeWorkspace) details.workspace = 'wiped';
      if (!Object.keys(details).length && token === null) return cur; // no-op: no write, no audit
      repoStore.tx(() => {
        repoStore.updateRepo(id, next);
        if (enabled !== cur.enabled) repoStore.setEnabled(id, enabled);
        if (dropToken) {
          repoStore.deleteSecret(id);
          details.token = 'dropped';
        }
        // After updateRepo: the AAD uses the new origin.
        if (token !== null) details.token = tokenNote(repoStore.setToken(id, token).hint);
        audit(ctx, 'repo.update', id, details);
      });
      if (wipeWorkspace) wipe(e.workspaceDir);
      const ne = swap(id);
      announce(ctx, 'repo.update', id, details);
      return ne.config;
    },

    setEnabled,

    /**
     * Replace the https token (write-only; never returned). The entry is unchanged: GitSync reads the token per sync.
     * @param {string} id @param {unknown} token @param {MutationContext} ctx
     * @throws {RepoMutationError}
     */
    setToken(id, token, ctx) {
      const e = mustGet(id);
      if (e.config.kind !== 'https') throw new RepoMutationError(400, 'tokens only apply to https repos');
      const t = checkToken(token);
      /** @type {Record<string, unknown>} */
      const details = {};
      repoStore.tx(() => {
        details.token = tokenNote(repoStore.setToken(id, t).hint);
        audit(ctx, 'token.set', id, details);
      });
      announce(ctx, 'token.set', id, details);
    },

    /**
     * Delete a repo, its token and its workspace. 409 while it has queued/pulling/running jobs. Job history stays.
     * @param {string} id @param {MutationContext} ctx
     * @throws {RepoMutationError}
     */
    remove(id, ctx) {
      const e = mustGet(id);
      const a = activity(id);
      if (a.queued || a.running) {
        throw new RepoMutationError(409, `repo has ${a.queued} queued and ${a.running} running job(s); disable it and wait for them to finish`);
      }
      const details = { url: e.config.url, kind: e.config.kind };
      repoStore.tx(() => {
        repoStore.deleteRepo(id);
        audit(ctx, 'repo.delete', id, details);
      });
      entries.delete(id);
      wipe(e.workspaceDir);
      announce(ctx, 'repo.delete', id, details);
    },

    /** @param {{ repoId?: string|null, limit?: number, before?: number|null }} [q] */
    listAudit: (q) => repoStore.listAudit(q),

    /**
     * Admin view of one repo. Health comes from the newest job that reached "pulling":
     * still pulling -> syncing; went on to running -> ok; failed while pulling -> sync_error.
     * @param {string} id
     * @param {import('./jobStore.js').JobStore} store
     * @param {Pick<import('./worker.js').Worker, 'queueLength'|'stats'>} worker
     * @returns {RepoStatus|null}
     */
    status(id, store, worker) {
      const e = entries.get(id);
      if (!e) return null;
      const jobs = store.list().filter((j) => j.repo_id === id);
      /** @type {Record<string, number>} */
      const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
      for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;

      let lastSync = null;
      let health = /** @type {RepoHealth} */ ('never_synced');
      for (let i = jobs.length - 1; i >= 0; i--) {
        const j = jobs[i];
        const idx = j.history.findIndex((h) => h.status === STATUS.PULLING);
        if (idx < 0) continue;
        const pulledAt = j.history[idx].at;
        const after = j.history[idx + 1];
        if (!after) { health = 'syncing'; break; }
        const ok = after.status === STATUS.RUNNING;
        health = ok ? 'ok' : 'sync_error';
        lastSync = {
          at: pulledAt,
          ok,
          branch: j.branch,
          commit: ok ? j.commit : null,
          duration_ms: Date.parse(after.at) - Date.parse(pulledAt),
          error: ok ? null : j.error,
          job_id: j.id,
        };
        break;
      }

      const runningJob = worker.stats().running.find((r) => r.repoId === id);
      const last = jobs.at(-1);
      return {
        id,
        url_display: e.config.url,
        default_branch: e.config.defaultBranch,
        workspace_dir: e.workspaceDir,
        cloned: fs.existsSync(path.join(e.workspaceDir, '.git')),
        health,
        last_sync: lastSync,
        counts,
        running_job_id: runningJob?.jobId ?? null,
        queued: worker.queueLength(id),
        last_job: last ? { id: last.id, status: last.status, created_at: last.created_at, finished_at: last.finished_at } : null,
        enabled: e.config.enabled,
        auth: (() => {
          const t = e.config.kind === 'https' ? repoStore.tokenInfo(id) : null;
          return {
            kind: e.config.kind,
            token: t ? { set: /** @type {const} */ (true), hint: t.hint, updated_at: t.updatedAt } : null,
            ssh_key_path: e.config.sshKeyPath,
          };
        })(),
      };
    },
  };
}

/** @typedef {ReturnType<typeof createRepoRegistry>} RepoRegistry */
