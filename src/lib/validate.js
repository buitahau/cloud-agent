// src/lib/validate.js
// Small pure validators shared by config, server and gitSync.

/** Max accepted prompt length in characters (guards argv/stdin size and memory). */
export const MAX_PROMPT_LENGTH = 100_000;

/**
 * Conservative git branch-name check. We never use a shell, but the name is passed as a git
 * argument, so it must not look like an option or contain ref-illegal sequences.
 *
 * Accept iff ALL hold:
 *  - typeof name === 'string', 1..200 chars
 *  - matches /^[A-Za-z0-9._\/-]+$/
 *  - does not start with '-' or '/' and does not end with '/' or '.lock' or '.'
 *  - does not contain '..', '//', '@{'
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidBranchName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 200) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.lock') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return true;
}

/**
 * Validate a POST /run-agent body.
 * Rules:
 *  - body must be a plain object (not array/null)        -> else "body must be a JSON object"
 *  - body.prompt: string, trimmed length >= 1, length <= MAX_PROMPT_LENGTH
 *                                                         -> else "prompt is required and must be a non-empty string" /
 *                                                            "prompt exceeds N characters"
 *  - body.branch: optional; if present and not null it must pass isValidBranchName
 *                                                         -> else "branch is not a valid branch name"
 *  - Unknown extra fields are ignored.
 *  - Return the prompt exactly as sent (do not trim it); trimming is only for the emptiness check.
 *
 * @param {unknown} body
 * @returns {{ ok: true, prompt: string, branch: string|null } | { ok: false, error: string }}
 */
export function validateRunAgentBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { prompt, branch } = /** @type {Record<string, unknown>} */ (body);
  if (typeof prompt !== 'string' || prompt.trim().length < 1) {
    return { ok: false, error: 'prompt is required and must be a non-empty string' };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` };
  }
  if (branch !== undefined && branch !== null && !isValidBranchName(branch)) {
    return { ok: false, error: 'branch is not a valid branch name' };
  }
  return { ok: true, prompt, branch: branch ?? null };
}

/** Repo ids appear in URL paths (/<repo>/run-agent) and as workspace directory names. */
export const REPO_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Ids that would collide with top-level routes. */
export const RESERVED_REPO_IDS = Object.freeze(['admin', 'health', 'repos', 'run-agent']);

/**
 * Lowercase letters, digits and inner dashes, 1..40 chars, not a reserved route name.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidRepoId(id) {
  return typeof id === 'string' && REPO_ID_RE.test(id) && !RESERVED_REPO_IDS.includes(id);
}

/**
 * Classify and sanity-check a git remote URL from the repos file.
 *  - "https"  https://host/path   (no user:pass@ — the token is stored separately)
 *  - "ssh"    ssh://[user@]host[:port]/path  or scp-style user@host:path
 *  - "local"  file:///abs/path or an absolute filesystem path (tests use bare repos on disk)
 * Rejects: empty / >2000 chars / whitespace or control chars / leading "-" / http:// /
 * git remote-helper forms like "ext::sh -c ..." (they make git run commands) / anything else.
 *
 * @param {unknown} url
 * @returns {{ ok: true, kind: 'https'|'ssh'|'local' } | { ok: false, error: string }}
 */
export function validateRepoUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return { ok: false, error: 'url is required' };
  if (url.length > 2000) return { ok: false, error: 'url is too long' };
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return { ok: false, error: 'url must not contain whitespace or control characters' };
  if (url.startsWith('-')) return { ok: false, error: 'url must not start with "-"' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return { ok: false, error: 'git remote-helper URLs ("<transport>::...") are not allowed' };

  if (/^https:\/\//i.test(url)) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, error: 'url is not a valid https URL' }; }
    if (u.username || u.password) return { ok: false, error: 'url must not embed credentials; the token is stored separately' };
    if (!u.hostname || u.pathname.length <= 1) return { ok: false, error: 'url must include a host and a repository path' };
    return { ok: true, kind: 'https' };
  }
  if (/^http:\/\//i.test(url)) return { ok: false, error: 'plain http:// is not allowed; use https://' };
  if (/^ssh:\/\//i.test(url)) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, error: 'url is not a valid ssh URL' }; }
    if (u.password) return { ok: false, error: 'url must not embed a password' };
    if (!u.hostname || u.pathname.length <= 1) return { ok: false, error: 'url must include a host and a repository path' };
    return { ok: true, kind: 'ssh' };
  }
  if (/^file:\/\/\//i.test(url)) return { ok: true, kind: 'local' };
  if (url.startsWith('/')) return { ok: true, kind: 'local' };
  // scp-style: [user@]host:path — host has no "/" and the path does not start with "/"... git allows both.
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^/\\][^\\]*$/.test(url) || /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:\/[^\\]+$/.test(url)) {
    return { ok: true, kind: 'ssh' };
  }
  return { ok: false, error: 'url must be https://, ssh://, user@host:path, file:/// or an absolute path' };
}

/** Max page size for job listings. */
export const MAX_LIST_LIMIT = 200;

/**
 * Validate a job-list query (?status=&limit=&before=). `repo` comes from the path, not the query.
 * status: one status or a comma-separated list of them. limit: 1..200 (default 50). before: a job id cursor.
 *
 * @param {Record<string, unknown>} query
 * @param {readonly string[]} statuses   allowed status names
 * @returns {{ ok: true, statuses: string[]|null, limit: number, before: string|null } | { ok: false, error: string }}
 */
export function validateJobListQuery(query, statuses) {
  const q = query ?? {};
  let wanted = null;
  if (q.status !== undefined && q.status !== '') {
    if (typeof q.status !== 'string') return { ok: false, error: 'status must be a string' };
    wanted = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = wanted.find((s) => !statuses.includes(s));
    if (bad !== undefined) return { ok: false, error: `status must be one of ${statuses.join(', ')}` };
  }
  let limit = 50;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` };
    limit = n;
  }
  let before = null;
  if (q.before !== undefined && q.before !== '') {
    if (typeof q.before !== 'string' || !/^job_[A-Za-z0-9_]{1,64}$/.test(q.before)) return { ok: false, error: 'before must be a job id' };
    before = q.before;
  }
  return { ok: true, statuses: wanted, limit, before };
}
