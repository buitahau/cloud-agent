// src/repoRegistry.js
// The configured repos (from REPOS_FILE) with one GitSync each, plus repo health derived from job history.
// Repos are fixed at startup: changing them means editing REPOS_FILE and restarting.

import fs from 'node:fs';
import path from 'node:path';
import { createGitSync } from './gitSync.js';
import { STATUS } from './jobStore.js';

/**
 * @typedef {Object} RepoEntry
 * @property {import('./config.js').RepoConfig} config
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
 * @param {ReadonlyArray<import('./config.js').RepoConfig>} repos
 * @param {{ gitTimeoutMs: number, gitSyncFactory?: typeof createGitSync }} opts
 */
export function createRepoRegistry(repos, opts) {
  const factory = opts.gitSyncFactory ?? createGitSync;
  /** @type {Map<string, RepoEntry>} */
  const entries = new Map();
  for (const r of repos) {
    entries.set(r.id, {
      config: r,
      workspaceDir: r.workspaceDir,
      gitSync: factory({
        repoUrl: r.url,
        workspaceDir: r.workspaceDir,
        sshKeyPath: r.sshKeyPath ?? null,
        token: r.token ?? null,
        timeoutMs: opts.gitTimeoutMs,
      }),
    });
  }

  return {
    /** @param {string} id @returns {RepoEntry|undefined} */
    get: (id) => entries.get(id),
    /** @param {string} id */
    has: (id) => entries.has(id),
    ids: () => [...entries.keys()],
    /** @returns {import('./config.js').RepoConfig[]} */
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
