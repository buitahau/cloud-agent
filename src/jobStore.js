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
 * One live event of a job (SSE payload). `seq` is monotonic per job, starting at 1.
 * @typedef {Object} JobEvent
 * @property {number} seq
 * @property {string} type    status | log | init | assistant_text | thinking | tool_use | tool_result | result | ...
 * @property {string} at      ISO-8601
 * @property {object} data
 */

/**
 * Internal job record. Field names match the API contract (spec §5) exactly.
 * @typedef {Object} Job
 * @property {string}          id           "job_" + 32 lowercase hex chars (randomUUID without dashes)
 * @property {string}          repo_id      id of the target repo (a repo in the database)
 * @property {JobStatus}       status
 * @property {string}          prompt
 * @property {string}          branch       effective branch (payload override, else the repo's defaultBranch) — set at creation
 * @property {string|null}     commit       short HEAD sha (git rev-parse --short HEAD) once pulled
 * @property {string}          created_at   ISO-8601 (Date#toISOString)
 * @property {string|null}     started_at   set when entering "pulling"
 * @property {string|null}     finished_at  set when entering a terminal status
 * @property {string|null}     result       Claude's final text (parsed JSON `.result`), whenever available
 * @property {string|null}     error        non-null iff status is "failed" or "timeout"
 * @property {ClaudeMeta|null} claude       extra (additive) field, not in spec §5 example
 * @property {LogBuffer}       log          internal; exposed only as logs_tail
 * @property {Array<{status: JobStatus, at: string}>} history  every status entered, in order (admin API only)
 */

/**
 * Public JSON shape for GET /run-agent/:id. Key order as listed.
 * @typedef {Object} PublicJob
 * @property {string} id
 * @property {JobStatus} status
 * @property {string} prompt
 * @property {string} repo_id
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
 * @property {(input: { prompt: string, branch: string, repoId?: string }) => Job} create
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
 * @property {(id: string, type: string, data?: object) => JobEvent|null} appendEvent
 *           Record a live event (assistant_text, tool_use, ...) in the job's bounded event ring and push it to
 *           subscribers. Unknown id -> null. Never throws. appendLog / transition also emit 'log' / 'status' (+ 'result').
 * @property {(id: string, afterSeq?: number) => { events: JobEvent[], dropped: number }|null} readEvents
 *           Buffered events with seq > afterSeq, plus how many were already evicted from the ring. null if no such job.
 * @property {(id: string, fn: (evt: JobEvent) => void) => (() => void)|null} subscribe
 *           Live events appended after this call. Returns an unsubscribe fn (null if no such job).
 * @property {(job: Job) => PublicJob} toPublic
 * @property {(job: Job) => JobSummary} toSummary   compact row for listings
 * @property {(id: string) => string[]|null} readLog  every buffered log line (up to logCapacity)
 * @property {(q?: { repoId?: string|null, statuses?: string[]|null, limit?: number, before?: string|null }) => { jobs: Job[], next: string|null }} query
 *           Newest first. `before` is a job id cursor (exclusive); `next` is the cursor for the following page.
 * @property {() => Job[]} list    all jobs, creation order
 * @property {(records: object[]) => { loaded: number, interrupted: number }} hydrate
 *           Load persisted snapshots (see snapshot()) at startup. Jobs that were not finished become "failed"
 *           ("Service restarted while job was <status>"). Each gets a stream holding only its result event.
 * @property {(job: Job) => object} snapshot   JSON-safe copy for persistence (full log included once finished)
 */

/**
 * Row shape for job listings (admin dashboard, GET /<repo>/run-agent).
 * @typedef {Object} JobSummary
 * @property {string} id
 * @property {string} repo_id
 * @property {JobStatus} status
 * @property {string} branch
 * @property {string|null} commit
 * @property {string} created_at
 * @property {string|null} started_at
 * @property {string|null} finished_at
 * @property {number|null} queue_ms   queued -> pulling
 * @property {number|null} sync_ms    pulling -> running (or -> failed)
 * @property {number|null} run_ms     running -> terminal
 * @property {string} prompt_preview  first 200 chars
 * @property {string|null} error_preview  first 300 chars
 * @property {number|null} cost_usd
 * @property {number|null} num_turns
 */

/**
 * @param {Object} [opts]
 * @param {() => Date}   [opts.now]           default () => new Date()
 * @param {() => string} [opts.genId]         default () => 'job_' + randomUUID().replace(/-/g, '')
 * @param {number}       [opts.logsTailLines] default 50 — lines returned in logs_tail
 * @param {number}       [opts.logCapacity]   default 500 — lines kept per job
 * @param {number}       [opts.eventCapacity] default 2000 — live events kept per job (for SSE replay)
 * @param {number}       [opts.retentionMax]  default 1000 — finished jobs kept; older finished ones are dropped
 *                                            (queued/running jobs are never dropped)
 * @param {number}       [opts.eventRetentionJobs] default 50 — finished jobs whose full event history is kept;
 *                                            older ones keep only their terminal result event
 * @param {(snapshot: object) => void} [opts.onPersist]  called on create and on every status change
 * @returns {JobStore}
 */
const PATCH_KEYS = Object.freeze(['commit', 'result', 'error', 'claude']);

export function createJobStore(opts = {}) {
  const now = opts.now ?? (() => new Date());
  const genId = opts.genId ?? (() => 'job_' + randomUUID().replace(/-/g, ''));
  const logsTailLines = opts.logsTailLines ?? 50;
  const logCapacity = opts.logCapacity ?? 500;
  const eventCapacity = opts.eventCapacity ?? 2000;
  const retentionMax = opts.retentionMax ?? 1000;
  const eventRetentionJobs = opts.eventRetentionJobs ?? 50;
  const onPersist = opts.onPersist ?? null;
  /** ids of finished jobs, oldest finish first */
  const finishedOrder = [];
  /** @type {Map<string, { events: JobEvent[], nextSeq: number, subs: Set<(e: JobEvent) => void> }>} */
  const streams = new Map();

  const emit = (id, type, data = {}) => {
    const st = streams.get(id);
    if (!st) return null;
    /** @type {JobEvent} */
    // wall clock, not the injected now(): job timestamps stay deterministic under test clocks
    const evt = { seq: st.nextSeq++, type, at: new Date().toISOString(), data };
    st.events.push(evt);
    if (st.events.length > eventCapacity) st.events.shift();
    for (const fn of [...st.subs]) {
      try { fn(evt); } catch { /* a bad subscriber must never break the job */ }
    }
    return evt;
  };
  /** @type {Map<string, Job>} */
  const jobs = new Map();

  const mustGet = (id) => {
    const job = jobs.get(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  };
  const persist = (job) => {
    if (!onPersist) return;
    try { onPersist(snapshot(job)); } catch { /* persistence must never break a job */ }
  };
  const snapshot = (job) => {
    const terminal = TERMINAL_STATUSES.has(job.status);
    return {
      id: job.id,
      repo_id: job.repo_id,
      status: job.status,
      prompt: job.prompt,
      branch: job.branch,
      commit: job.commit,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      result: job.result,
      error: job.error,
      claude: job.claude ? { ...job.claude } : null,
      history: job.history.map((h) => ({ ...h })),
      ...(terminal ? { log: [...job.log.lines] } : {}),
    };
  };
  /** Replace a finished job's event ring with just its terminal result event (keeps SSE replay working). */
  const trimEvents = (id) => {
    const st = streams.get(id);
    if (!st) return;
    const last = st.events.findLast?.((e) => e.type === 'result') ?? [...st.events].reverse().find((e) => e.type === 'result');
    st.events = last ? [last] : [];
  };
  const onFinished = (id) => {
    finishedOrder.push(id);
    if (finishedOrder.length > eventRetentionJobs) {
      const older = finishedOrder[finishedOrder.length - 1 - eventRetentionJobs];
      trimEvents(older);
    }
    while (finishedOrder.length > retentionMax) {
      const old = /** @type {string} */ (finishedOrder.shift());
      jobs.delete(old);
      streams.delete(old);
    }
  };
  const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  const historyAt = (job, status) => job.history.find((h) => h.status === status)?.at ?? null;
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
    create({ prompt, branch, repoId = 'default' }) {
      const id = genId();
      const createdAt = now().toISOString();
      /** @type {Job} */
      const job = {
        id,
        repo_id: repoId,
        status: STATUS.QUEUED,
        prompt,
        branch,
        commit: null,
        created_at: createdAt,
        started_at: null,
        finished_at: null,
        result: null,
        error: null,
        claude: null,
        log: new LogBuffer(logCapacity),
        history: [{ status: STATUS.QUEUED, at: createdAt }],
      };
      jobs.set(id, job);
      streams.set(id, { events: [], nextSeq: 1, subs: new Set() });
      persist(job);
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
      const at = now().toISOString();
      job.history.push({ status: to, at });
      if (to === STATUS.PULLING) job.started_at = at;
      if (TERMINAL_STATUSES.has(to)) job.finished_at = at;
      job.log.push(`[job] ${from} -> ${to}`);
      emit(id, 'status', { status: to, from });
      if (TERMINAL_STATUSES.has(to)) {
        // Terminal marker: SSE streams close after this event.
        emit(id, 'result', { status: to, result: job.result, error: job.error, claude: job.claude ? { ...job.claude } : null });
        streams.get(id)?.subs.clear();
      }
      persist(job);
      if (TERMINAL_STATUSES.has(to)) onFinished(id);
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
      try { emit(id, 'log', { line: String(text) }); } catch { /* ditto */ }
    },

    appendEvent(id, type, data) {
      try { return emit(id, type, data ?? {}); } catch { return null; }
    },

    readEvents(id, afterSeq = 0) {
      const st = streams.get(id);
      if (!st) return null;
      const after = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
      const firstSeq = st.events.length ? st.events[0].seq : st.nextSeq;
      return {
        events: st.events.filter((e) => e.seq > after),
        dropped: Math.max(0, firstSeq - after - 1),
      };
    },

    subscribe(id, fn) {
      const st = streams.get(id);
      if (!st) return null;
      st.subs.add(fn);
      return () => { st.subs.delete(fn); };
    },

    toPublic(job) {
      return {
        id: job.id,
        status: job.status,
        prompt: job.prompt,
        repo_id: job.repo_id,
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

    toSummary(job) {
      const pulling = historyAt(job, STATUS.PULLING);
      const running = historyAt(job, STATUS.RUNNING);
      const syncEnd = running ?? (pulling && !running ? job.finished_at : null);
      return {
        id: job.id,
        repo_id: job.repo_id,
        status: job.status,
        branch: job.branch,
        commit: job.commit,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        queue_ms: ms(job.created_at, pulling),
        sync_ms: ms(pulling, syncEnd),
        run_ms: ms(running, running ? job.finished_at : null),
        prompt_preview: job.prompt.length > 200 ? `${job.prompt.slice(0, 200)}…` : job.prompt,
        error_preview: job.error === null ? null : (job.error.length > 300 ? `${job.error.slice(0, 300)}…` : job.error),
        cost_usd: job.claude?.total_cost_usd ?? null,
        num_turns: job.claude?.num_turns ?? null,
      };
    },

    readLog(id) {
      const job = jobs.get(id);
      return job ? [...job.log.lines] : null;
    },

    query({ repoId = null, statuses = null, limit = 50, before = null } = {}) {
      const all = [...jobs.values()];
      let end = all.length;
      if (before !== null) {
        const i = all.findIndex((j) => j.id === before);
        end = i < 0 ? 0 : i;
      }
      const out = [];
      let i = end - 1;
      for (; i >= 0 && out.length < limit; i--) {
        const j = all[i];
        if (repoId !== null && j.repo_id !== repoId) continue;
        if (statuses !== null && !statuses.includes(j.status)) continue;
        out.push(j);
      }
      // there is a next page iff an older matching job exists
      let more = false;
      for (; i >= 0; i--) {
        const j = all[i];
        if ((repoId === null || j.repo_id === repoId) && (statuses === null || statuses.includes(j.status))) { more = true; break; }
      }
      return { jobs: out, next: more && out.length ? out[out.length - 1].id : null };
    },

    list() {
      return [...jobs.values()];
    },

    snapshot,

    hydrate(records) {
      let loaded = 0;
      let interrupted = 0;
      const sorted = [...records]
        .filter((r) => r && typeof r.id === 'string' && !jobs.has(r.id) && STATUS[String(r.status).toUpperCase()] === r.status)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      for (const r of sorted) {
        const log = new LogBuffer(logCapacity);
        for (const line of Array.isArray(r.log) ? r.log : []) log.push(String(line));
        /** @type {Job} */
        const job = {
          id: r.id,
          repo_id: typeof r.repo_id === 'string' ? r.repo_id : 'default',
          status: r.status,
          prompt: String(r.prompt ?? ''),
          branch: String(r.branch ?? ''),
          commit: r.commit ?? null,
          created_at: String(r.created_at),
          started_at: r.started_at ?? null,
          finished_at: r.finished_at ?? null,
          result: r.result ?? null,
          error: r.error ?? null,
          claude: r.claude ?? null,
          log,
          history: Array.isArray(r.history) ? r.history.map((h) => ({ status: h.status, at: h.at })) : [],
        };
        jobs.set(job.id, job);
        streams.set(job.id, { events: [], nextSeq: 1, subs: new Set() });
        loaded++;
        if (!TERMINAL_STATUSES.has(job.status)) {
          interrupted++;
          const was = job.status;
          // queued/pulling/running -> failed are all legal transitions
          this.transition(job.id, STATUS.FAILED, { error: `Service restarted while job was ${was}` });
        } else {
          emit(job.id, 'result', { status: job.status, result: job.result, error: job.error, claude: job.claude ? { ...job.claude } : null });
          onFinished(job.id);
        }
      }
      // restored jobs only need their result event
      for (const id of finishedOrder) trimEvents(id);
      return { loaded, interrupted };
    },
  };
}
