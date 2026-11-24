// src/jobStore.js
// In-memory job records + the ONLY code allowed to change a job's status.
// Synchronous API (no awaits) so there are no interleaving issues.

import { randomUUID } from 'node:crypto';
import { LogBuffer } from './lib/logBuffer.js';

/** @typedef {'queued'|'pulling'|'running'|'succeeded'|'failed'|'timeout'} JobStatus */

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  PULLING: 'pulling',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
});

/** Terminal statuses: no transitions out of these. */
export const TERMINAL_STATUSES = Object.freeze(new Set(['succeeded', 'failed', 'timeout']));

/**
 * Allowed transitions (spec §6). queued->failed exists for jobs that can't start
 * (e.g. service shutting down / unexpected worker error before pulling).
 * @type {Readonly<Record<JobStatus, readonly JobStatus[]>>}
 */
export const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['pulling', 'failed']),
  pulling: Object.freeze(['running', 'failed']),
  running: Object.freeze(['succeeded', 'failed', 'timeout']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  timeout: Object.freeze([]),
});

/**
 * Claude run metadata parsed from `--output-format json` (null until the claude step finishes,
 * and stays null if the output could not be parsed).
 * @typedef {Object} ClaudeMeta
 * @property {string|null}  session_id
 * @property {number|null}  total_cost_usd
 * @property {number|null}  num_turns
 * @property {number|null}  duration_ms
 * @property {string|null}  subtype       e.g. "success", "error_max_turns", "error_during_execution"
 * @property {boolean|null} is_error
 */

/**
 * Internal job record. Field names match the API contract (spec §5) exactly.
 * @typedef {Object} Job
 * @property {string}          id           "job_" + 32 lowercase hex chars (randomUUID without dashes)
 * @property {JobStatus}       status
 * @property {string}          prompt
 * @property {string}          branch       effective branch (payload override, else config.repoBranch) — set at creation
 * @property {string|null}     commit       short HEAD sha (git rev-parse --short HEAD) once pulled
 * @property {string}          created_at   ISO-8601 (Date#toISOString)
 * @property {string|null}     started_at   set when entering "pulling"
 * @property {string|null}     finished_at  set when entering a terminal status
 * @property {string|null}     result       Claude's final text (parsed JSON `.result`), whenever available
 * @property {string|null}     error        non-null iff status is "failed" or "timeout"
 * @property {ClaudeMeta|null} claude       extra (additive) field, not in spec §5 example
 * @property {LogBuffer}       log          internal; exposed only as logs_tail
 */

/**
 * Public JSON shape for GET /run-agent/:id. Key order as listed.
 * @typedef {Object} PublicJob
 * @property {string} id
 * @property {JobStatus} status
 * @property {string} prompt
 * @property {string} branch
 * @property {string|null} commit
 * @property {string} created_at
 * @property {string|null} started_at
 * @property {string|null} finished_at
 * @property {string|null} result
 * @property {string|null} error
 * @property {string} logs_tail     last N log lines joined by "\n" ("" if none)
 * @property {ClaudeMeta|null} claude
 */

export class JobNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) { super(`job not found: ${id}`); this.name = 'JobNotFoundError'; this.id = id; }
}

export class IllegalTransitionError extends Error {
  /** @param {string} id @param {JobStatus} from @param {JobStatus} to */
  constructor(id, from, to) {
    super(`illegal transition for ${id}: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    Object.assign(this, { id, from, to });
  }
}

/**
 * @typedef {Object} JobStore
 * @property {(input: { prompt: string, branch: string }) => Job} create
 *           New job with status "queued", created_at = now, all nullable fields null, fresh LogBuffer.
 * @property {(id: string) => Job|undefined} get
 * @property {(id: string, to: JobStatus, patch?: Partial<Pick<Job,'commit'|'result'|'error'|'claude'>>) => Job} transition
 *           Validates `to` against TRANSITIONS[current] (throw IllegalTransitionError), applies patch,
 *           sets started_at when to === "pulling", finished_at when `to` is terminal. Throws JobNotFoundError.
 *           Also appends a log line "[job] <from> -> <to>".
 * @property {(id: string, patch: Partial<Pick<Job,'commit'|'result'|'error'|'claude'>>) => Job} update
 *           Patch non-status fields. Throws if patch contains `status` or any key outside the allowed four.
 * @property {(id: string, text: string) => void} appendLog
 *           Push text into the job's LogBuffer. Unknown id -> silently ignore (logging must never throw).
 * @property {(job: Job) => PublicJob} toPublic
 * @property {() => Job[]} list    all jobs, creation order (for debugging/tests)
 */

/**
 * @param {Object} [opts]
 * @param {() => Date}   [opts.now]           default () => new Date()
 * @param {() => string} [opts.genId]         default () => 'job_' + randomUUID().replace(/-/g, '')
 * @param {number}       [opts.logsTailLines] default 50 — lines returned in logs_tail
 * @param {number}       [opts.logCapacity]   default 500 — lines kept per job
 * @returns {JobStore}
 */
const PATCH_KEYS = Object.freeze(['commit', 'result', 'error', 'claude']);

export function createJobStore(opts = {}) {
  const now = opts.now ?? (() => new Date());
  const genId = opts.genId ?? (() => 'job_' + randomUUID().replace(/-/g, ''));
  const logsTailLines = opts.logsTailLines ?? 50;
  const logCapacity = opts.logCapacity ?? 500;
  /** @type {Map<string, Job>} */
  const jobs = new Map();

  const mustGet = (id) => {
    const job = jobs.get(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  };
  const applyPatch = (job, patch) => {
    if (!patch) return;
    for (const key of Object.keys(patch)) {
      if (!PATCH_KEYS.includes(key)) throw new Error(`cannot patch job field "${key}"`);
    }
    for (const key of PATCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) job[key] = patch[key];
    }
  };

  return {
    create({ prompt, branch }) {
      const id = genId();
      /** @type {Job} */
      const job = {
        id,
        status: STATUS.QUEUED,
        prompt,
        branch,
        commit: null,
        created_at: now().toISOString(),
        started_at: null,
        finished_at: null,
        result: null,
        error: null,
        claude: null,
        log: new LogBuffer(logCapacity),
      };
      jobs.set(id, job);
      return job;
    },

    get(id) {
      return jobs.get(id);
    },

    transition(id, to, patch) {
      const job = mustGet(id);
      const from = job.status;
      const allowed = TRANSITIONS[from] ?? [];
      if (!allowed.includes(to)) throw new IllegalTransitionError(id, from, to);
      applyPatch(job, patch);
      job.status = to;
      if (to === STATUS.PULLING) job.started_at = now().toISOString();
      if (TERMINAL_STATUSES.has(to)) job.finished_at = now().toISOString();
      job.log.push(`[job] ${from} -> ${to}`);
      return job;
    },

    update(id, patch) {
      const job = mustGet(id);
      applyPatch(job, patch ?? {});
      return job;
    },

    appendLog(id, text) {
      const job = jobs.get(id);
      if (!job) return;
      try { job.log.push(text); } catch { /* logging must never throw */ }
    },

    toPublic(job) {
      return {
        id: job.id,
        status: job.status,
        prompt: job.prompt,
        branch: job.branch,
        commit: job.commit,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        result: job.result,
        error: job.error,
        logs_tail: job.log.tail(logsTailLines),
        claude: job.claude ? { ...job.claude } : null,
      };
    },

    list() {
      return [...jobs.values()];
    },
  };
}
