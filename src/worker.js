// src/worker.js
// FIFO queue + single worker: exactly one job runs at a time against the single workspace (spec §7, T11).

import { STATUS, TERMINAL_STATUSES } from './jobStore.js';

/**
 * @typedef {Object} Worker
 * @property {(id: string) => void} enqueue
 *           Push id onto the FIFO and schedule a drain (setImmediate). Returns synchronously — POST must not wait.
 * @property {() => number} queueLength      ids waiting (excludes the one running)
 * @property {() => string|null} currentJobId
 * @property {() => Promise<void>} onIdle    resolves when queue is empty AND nothing is running (immediately if idle).
 *                                            Used by tests and graceful shutdown.
 * @property {(reason?: string) => Promise<void>} shutdown
 *           Stop accepting work: mark every still-queued job failed (error = reason ?? 'Service shutting down'),
 *           abort the running job's AbortController (claude/git process group gets killed by runProcess),
 *           then await onIdle(). After shutdown, enqueue() marks the job failed immediately.
 */

/**
 * @typedef {Object} WorkerDeps
 * @property {import('./jobStore.js').JobStore} store
 * @property {import('./gitSync.js').GitSync} gitSync
 * @property {import('./claudeRunner.js').ClaudeRunner} claudeRunner
 * @property {string} workspaceDir   cwd for claude
 * @property {{ info: Function, warn: Function, error: Function }} [logger=console]
 */

/**
 * Factory. Drain loop: `while (queue.length && !stopped) { await processJob(queue.shift()) }` guarded by a
 * `draining` flag so only one loop ever runs. processJob never throws (see below), but wrap it anyway and
 * log via logger.error — a bug must never kill the loop or the process (T9: "service stays up").
 *
 * @param {WorkerDeps} deps
 * @returns {Worker}
 */
export function createWorker(deps) {
  const logger = deps.logger ?? console;
  const { store } = deps;
  /** @type {string[]} */
  const queue = [];
  let draining = false;
  let stopped = false;
  let shutdownReason = 'Service shutting down';
  /** @type {string|null} */
  let current = null;
  /** @type {AbortController|null} */
  let currentAbort = null;
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  const isIdle = () => !draining && queue.length === 0 && current === null;
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

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const id = /** @type {string} */ (queue.shift());
        current = id;
        currentAbort = new AbortController();
        try {
          await processJob(deps, id, currentAbort.signal);
        } catch (err) {
          logger.error(`[worker] unexpected error processing ${id}:`, err);
        } finally {
          current = null;
          currentAbort = null;
        }
      }
    } finally {
      draining = false;
      notifyIdle();
    }
  }

  return {
    enqueue(id) {
      if (stopped) {
        failQueued(id, shutdownReason);
        return;
      }
      queue.push(id);
      setImmediate(() => { drain().catch((err) => logger.error('[worker] drain failed:', err)); });
    },
    queueLength: () => queue.length,
    currentJobId: () => current,
    onIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    async shutdown(reason) {
      stopped = true;
      shutdownReason = reason ?? 'Service shutting down';
      const pending = queue.splice(0, queue.length);
      for (const id of pending) failQueued(id, shutdownReason);
      if (currentAbort) currentAbort.abort();
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
 *  4. out = await claudeRunner.run({ prompt: job.prompt, cwd: workspaceDir, log: line => store.appendLog(id, line), signal })
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
    const out = await claudeRunner.run({ prompt: job.prompt, cwd: workspaceDir, log, signal });
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
