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
