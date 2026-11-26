// src/worker.js
// Scheduler: one global FIFO, at most ONE job per repo at a time (each repo has a single working tree), and at most
// maxConcurrent jobs overall. With maxConcurrent = 1 (the default) this is a strict FIFO, one job at a time (T11).

import { STATUS, TERMINAL_STATUSES } from './jobStore.js';

/**
 * @typedef {Object} Worker
 * @property {(id: string) => void} enqueue
 *           Push id onto the FIFO and schedule a pump (setImmediate). Returns synchronously — POST must not wait.
 * @property {(repoId?: string) => number} queueLength   ids waiting (excludes running ones), optionally for one repo
 * @property {() => string|null} currentJobId           first running job (compat with the single-lane worker)
 * @property {() => string[]} runningJobIds
 * @property {() => WorkerStats} stats
 * @property {() => Promise<void>} onIdle    resolves when queue is empty AND nothing is running (immediately if idle).
 *                                            Used by tests and graceful shutdown.
 * @property {() => void} poke   schedule a pump now (e.g. after a repo is disabled, so its queued jobs fail right away)
 * @property {(reason?: string) => Promise<void>} shutdown
 *           Stop accepting work: mark every still-queued job failed (error = reason ?? 'Service shutting down'),
 *           abort every running job's AbortController (claude/git process group gets killed by runProcess),
 *           then await onIdle(). After shutdown, enqueue() marks the job failed immediately.
 */

/**
 * @typedef {Object} WorkerStats
 * @property {number} maxConcurrent
 * @property {number} queued
 * @property {Array<{ jobId: string, repoId: string }>} running
 */

/**
 * What the worker needs to run a job against one repo.
 * @typedef {Object} RepoRuntime
 * @property {import('./gitSync.js').GitSync} gitSync
 * @property {string} workspaceDir   cwd for claude
 * @property {{ enabled?: boolean }} [config]   registry entries carry it; enabled === false fails the repo's queued
 *           jobs ("repo disabled") when the worker next looks at them. A running job keeps the entry it started with.
 */

/**
 * @typedef {Object} WorkerDeps
 * @property {import('./jobStore.js').JobStore} store
 * @property {import('./claudeRunner.js').ClaudeRunner} claudeRunner   shared by all repos (stateless per run)
 * @property {{ get(id: string): RepoRuntime|undefined }} [repos]     registry (a Map works). Required unless the
 *           single-repo form { gitSync, workspaceDir } is given, which becomes repo "default".
 * @property {import('./gitSync.js').GitSync} [gitSync]
 * @property {string} [workspaceDir]
 * @property {number} [maxConcurrent=1]
 * @property {{ info: Function, warn: Function, error: Function }} [logger=console]
 */

/**
 * Factory. pump() walks the FIFO and starts every job whose repo is free while running < maxConcurrent; a job whose
 * repo is busy is skipped (it keeps its place), so per-repo order is FIFO and other repos are not blocked behind it.
 * processJob never throws (see below), but it is wrapped anyway — a bug must never kill the scheduler (T9).
 *
 * @param {WorkerDeps} deps
 * @returns {Worker}
 */
export function createWorker(deps) {
  const logger = deps.logger ?? console;
  const { store } = deps;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1);
  const repos = deps.repos ?? new Map([['default', { gitSync: deps.gitSync, workspaceDir: deps.workspaceDir }]]);
  /** @type {string[]} */
  const queue = [];
  /** @type {Map<string, { repoId: string, abort: AbortController }>} jobId -> running entry (insertion = start order) */
  const running = new Map();
  /** @type {Set<string>} */
  const busyRepos = new Set();
  let stopped = false;
  let pumpScheduled = false;
  let shutdownReason = 'Service shutting down';
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  const isIdle = () => !pumpScheduled && queue.length === 0 && running.size === 0;
  const notifyIdle = () => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const failQueued = (id, reason) => {
    try {
      const job = store.get(id);
      if (job && job.status === STATUS.QUEUED) store.transition(id, STATUS.FAILED, { error: reason });
    } catch (err) {
      logger.error(`[worker] could not fail job ${id}:`, err);
    }
  };

  const schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      try { pump(); } catch (err) { logger.error('[worker] pump failed:', err); }
      notifyIdle();
    });
  };

  function pump() {
    for (let i = 0; i < queue.length && !stopped;) {
      const id = queue[i];
      const job = store.get(id);
      if (!job || job.status !== STATUS.QUEUED) { // vanished (retention) or already handled: drop it
        queue.splice(i, 1);
        continue;
      }
      // Looked up at pick time, so a queued job uses the repo as it is NOW (it may have been edited, disabled or
      // deleted). Unknown/disabled jobs fail before the busy/capacity skips, so they fail even when every slot is full.
      const repo = repos.get(job.repo_id);
      if (!repo) { queue.splice(i, 1); failQueued(id, `unknown repo "${job.repo_id}"`); continue; }
      if (repo.config?.enabled === false) { queue.splice(i, 1); failQueued(id, 'repo disabled'); continue; }
      if (running.size >= maxConcurrent || busyRepos.has(job.repo_id)) { i++; continue; }
      queue.splice(i, 1);
      start(id, job.repo_id, repo);
    }
  }

  function start(id, repoId, repo) {
    const abort = new AbortController();
    running.set(id, { repoId, abort });
    busyRepos.add(repoId);
    const jobDeps = { store, claudeRunner: deps.claudeRunner, logger, gitSync: repo.gitSync, workspaceDir: repo.workspaceDir };
    Promise.resolve()
      .then(() => processJob(jobDeps, id, abort.signal))
      .catch((err) => logger.error(`[worker] unexpected error processing ${id}:`, err))
      .finally(() => {
        running.delete(id);
        busyRepos.delete(repoId);
        if (queue.length && !stopped) schedulePump();
        notifyIdle();
      });
  }

  return {
    enqueue(id) {
      if (stopped) {
        failQueued(id, shutdownReason);
        return;
      }
      queue.push(id);
      schedulePump();
    },
    poke() {
      if (!stopped) schedulePump();
    },
    queueLength(repoId) {
      if (repoId === undefined) return queue.length;
      return queue.filter((id) => store.get(id)?.repo_id === repoId).length;
    },
    currentJobId: () => running.keys().next().value ?? null,
    runningJobIds: () => [...running.keys()],
    stats: () => ({
      maxConcurrent,
      queued: queue.length,
      running: [...running].map(([jobId, r]) => ({ jobId, repoId: r.repoId })),
    }),
    onIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    async shutdown(reason) {
      stopped = true;
      shutdownReason = reason ?? 'Service shutting down';
      const pending = queue.splice(0, queue.length);
      for (const id of pending) failQueued(id, shutdownReason);
      for (const r of running.values()) r.abort.abort();
      notifyIdle();
      await this.onIdle();
    },
  };
}

/**
 * Run ONE job end-to-end. Never throws. Exported for unit tests.
 *
 *  1. store.transition(id, 'pulling')
 *  2. try { { commit } = await gitSync.sync(job.branch, line => store.appendLog(id, line), signal) }
 *     catch (e) { store.transition(id, 'failed', { error: e.message }); return }
 *     store.update(id, { commit })
 *     (if aborted during pulling -> 'failed' with error 'Service shutting down')
 *  3. store.transition(id, 'running')
 *  4. out = await claudeRunner.run({ prompt: job.prompt, cwd: workspaceDir, log: line => store.appendLog(id, line),
 *                                   onEvent: (type, data) => store.appendEvent(id, type, data), signal })
 *  5. store.transition(id, out.outcome, { result: out.result, error: out.error, claude: out.meta })
 *  Any unexpected exception anywhere: if job not terminal -> transition to 'failed' with
 *  error `Internal error: ${e.message}`; log stack via logger.error.
 *
 * @param {WorkerDeps} deps
 * @param {string} id
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function processJob(deps, id, signal) {
  const { store, gitSync, claudeRunner, workspaceDir } = deps;
  const logger = deps.logger ?? console;
  const log = (line) => store.appendLog(id, line);
  const onEvent = (type, data) => store.appendEvent(id, type, data);
  try {
    const job = store.get(id);
    if (!job) {
      logger.warn(`[worker] job ${id} not found; skipping`);
      return;
    }
    if (job.status !== STATUS.QUEUED) {
      logger.warn(`[worker] job ${id} is ${job.status}, not queued; skipping`);
      return;
    }
    if (signal?.aborted) {
      store.transition(id, STATUS.FAILED, { error: 'Service shutting down' });
      return;
    }

    store.transition(id, STATUS.PULLING);
    let commit;
    try {
      ({ commit } = await gitSync.sync(job.branch, log, signal));
    } catch (err) {
      const error = signal?.aborted ? 'Service shutting down' : (err?.name === 'GitSyncError'
        ? err.message
        : `Internal error: ${err?.message ?? err}`);
      if (err?.name !== 'GitSyncError' && !signal?.aborted) logger.error(`[worker] job ${id} git step:`, err);
      store.transition(id, STATUS.FAILED, { error });
      return;
    }
    store.update(id, { commit });
    if (signal?.aborted) {
      store.transition(id, STATUS.FAILED, { error: 'Service shutting down' });
      return;
    }

    store.transition(id, STATUS.RUNNING);
    const out = await claudeRunner.run({ prompt: job.prompt, cwd: workspaceDir, log, onEvent, signal });
    store.transition(id, out.outcome, { result: out.result, error: out.error, claude: out.meta });
  } catch (err) {
    logger.error(`[worker] job ${id} internal error:`, err);
    try {
      const job = store.get(id);
      if (job && !TERMINAL_STATUSES.has(job.status)) {
        store.transition(id, STATUS.FAILED, { error: `Internal error: ${err?.message ?? err}` });
      }
    } catch (err2) {
      logger.error(`[worker] job ${id} could not be marked failed:`, err2);
    }
  }
}
