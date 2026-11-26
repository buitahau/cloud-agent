// src/repoRegistry.js
// The repos (loaded from the database once at startup) with one GitSync each, plus repo health derived from
// job history. Tokens are never held here: each GitSync reads its repo's token from the store per sync.
// The set of repos is fixed for the process lifetime; changing it at runtime comes with the admin API (PR 3).

import fs from 'node:fs';
import path from 'node:path';
import { createGitSync } from './gitSync.js';
import { STATUS } from './jobStore.js';

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
 * @property {{ id: string, status: string, created_at: string, finished_at: string|null }|null} last_job
 */

/**
 * @param {{ repoStore: Pick<import('./repoStore.js').RepoStore, 'list'|'getToken'>, workspaceRoot: string, gitTimeoutMs: number,
 *           secretEnvNames?: string[], gitSyncFactory?: typeof createGitSync }} opts
 */
export function createRepoRegistry(opts) {
  const factory = opts.gitSyncFactory ?? createGitSync;
  /** @type {Map<string, RepoEntry>} */
  const entries = new Map();
  for (const rec of opts.repoStore.list()) {
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
    entries.set(rec.id, {
      config,
      workspaceDir,
      gitSync: factory({
        repoUrl: rec.url,
        workspaceDir,
        sshKeyPath: config.sshKeyPath,
        getToken: () => opts.repoStore.getToken(rec.id),
        timeoutMs: opts.gitTimeoutMs,
        secretEnvNames: opts.secretEnvNames ?? [],
      }),
    });
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
      };
    },
  };
}

/** @typedef {ReturnType<typeof createRepoRegistry>} RepoRegistry */
