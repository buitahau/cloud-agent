// Hand-written mirrors of the admin API shapes. Source of truth: JSDoc in src/jobStore.js, src/repoRegistry.js and
// src/repoStore.js (audit), and the handlers in src/admin.js. Keep in sync when those change.

export const JOB_STATUSES = ['queued', 'pulling', 'running', 'succeeded', 'failed', 'timeout'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'timeout'];
export type StatusCounts = Record<JobStatus, number>;

export type RepoHealth = 'ok' | 'syncing' | 'sync_error' | 'never_synced';

export type RepoKind = 'https' | 'ssh' | 'local';
export interface TokenInfo { set: true; hint: string; updated_at: string }
export interface RepoAuth { kind: RepoKind; token: TokenInfo | null; ssh_key_path: string | null }

/** POST /admin/api/repos */
export interface RepoCreate { id: string; url: string; defaultBranch?: string; sshKeyPath?: string; token?: string }
/** PATCH /admin/api/repos/:id */
export interface RepoPatch { url?: string; defaultBranch?: string; sshKeyPath?: string; enabled?: boolean; token?: string }

export type AuditAction = 'repo.create' | 'repo.update' | 'repo.enable' | 'repo.disable' | 'repo.delete' | 'token.set' | 'key.rotate' | 'import';
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  ip: string | null;
  action: AuditAction | (string & {});
  repo_id: string | null;
  details: Record<string, unknown>; // field: {from,to} | token: "set …a1b2" | "dropped" | workspace: "wiped" | ...
}
export interface AuditPage { entries: AuditEntry[]; next: number | null }

export interface Summary {
  uptime_s: number;
  max_concurrent: number;
  queued: number;
  running: { job_id: string; repo_id: string }[];
  counts: StatusCounts;
  last_24h: StatusCounts;
  repos: number;
  persistence: boolean;
}

export interface LastSync {
  at: string;
  ok: boolean;
  branch: string;
  commit: string | null;
  duration_ms: number | null;
  error: string | null;
  job_id: string;
}

export interface RepoStatus {
  id: string;
  url_display: string;
  default_branch: string;
  workspace_dir: string;
  cloned: boolean;
  health: RepoHealth;
  last_sync: LastSync | null;
  counts: StatusCounts;
  running_job_id: string | null;
  queued: number;
  last_job: { id: string; status: JobStatus; created_at: string; finished_at: string | null } | null;
  enabled: boolean;
  auth: RepoAuth;
}

export interface JobSummary {
  id: string;
  repo_id: string;
  status: JobStatus;
  branch: string;
  commit: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_ms: number | null;
  sync_ms: number | null;
  run_ms: number | null;
  prompt_preview: string;
  error_preview: string | null;
  cost_usd: number | null;
  num_turns: number | null;
}

export interface JobPage {
  jobs: JobSummary[];
  next: string | null;
}

export interface ClaudeInfo {
  session_id: string | null;
  total_cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  subtype: string | null;
  is_error: boolean | null;
}

export interface JobDetail {
  id: string;
  status: JobStatus;
  prompt: string;
  repo_id: string;
  branch: string;
  commit: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  logs_tail: string[];
  claude: ClaudeInfo | null;
  history: { status: JobStatus; at: string }[];
  log: string[];
  events_buffered: number;
}

// ---- SSE events (src/server.js, src/jobStore.js, src/claudeRunner.js toEvents) ----
export interface EventDataMap {
  status: { status: JobStatus; from: JobStatus | null };
  log: { line: string };
  result: { status: JobStatus; result: string | null; error: string | null; claude: ClaudeInfo | null };
  init: { session_id: string | null; model: string | null; tools: string[] };
  assistant_text: { text: string; truncated?: boolean };
  thinking: { text: string; truncated?: boolean; redacted?: boolean };
  tool_use: { id: string; name: string; input: unknown };
  tool_result: { tool_use_id: string; is_error: boolean; text: string; truncated?: boolean };
  gap: { dropped: number };
}
export type EventType = keyof EventDataMap;
export const EVENT_TYPES: EventType[] = ['status', 'init', 'assistant_text', 'thinking', 'tool_use', 'tool_result', 'log', 'gap', 'result'];

export type JobEvent = {
  [K in EventType]: { key: string; seq: number | null; type: K; data: EventDataMap[K] };
}[EventType];
