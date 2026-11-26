// src/lib/repoValidate.js
// Validation of one repo definition (id, url, defaultBranch, sshKeyPath) and of a repo token. Shared by the
// repos.json importer, the startup check of stored repos and (later) the admin API. Pure apart from
// fs.existsSync for the ssh key file. Never puts token values in error messages.

import fs from 'node:fs';
import path from 'node:path';
import { isValidBranchName, isValidRepoId, validateRepoUrl, RESERVED_REPO_IDS } from './validate.js';

/** Max accepted token length in characters. */
export const MAX_TOKEN_LENGTH = 1000;

/**
 * True iff `child` is `parent` or lies inside it. Both absolute.
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @typedef {Object} ValidRepo
 * @property {string} id
 * @property {string} url
 * @property {'https'|'ssh'|'local'} kind
 * @property {string} defaultBranch
 * @property {string|null} sshKeyPath  absolute (ssh only)
 */

/**
 * Validate a repo definition. Collects every problem. Extra input fields are ignored.
 * @param {unknown} input  { id, url, defaultBranch?, sshKeyPath? }
 * @param {{ allowLocal?: boolean, sshKeysDir?: string|null, checkKeyFile?: boolean }} [opts]
 * @returns {{ ok: true, repo: ValidRepo } | { ok: false, problems: string[] }}
 */
export function validateRepoInput(input, { allowLocal = false, sshKeysDir = null, checkKeyFile = true } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, problems: ['must be an object'] };
  const r = /** @type {Record<string, unknown>} */ (input);
  /** @type {string[]} */
  const problems = [];

  if (!isValidRepoId(r.id)) {
    problems.push(`id must be 1-40 chars of a-z, 0-9 and "-" (not at the ends), and not one of ${RESERVED_REPO_IDS.join(', ')}`);
  }

  const urlCheck = validateRepoUrl(r.url);
  if (!urlCheck.ok) problems.push(urlCheck.error);
  else if (urlCheck.kind === 'local' && !allowLocal) {
    problems.push('local repos (absolute paths, file://) are disabled; set ALLOW_LOCAL_REPOS=true to allow them');
  }

  const defaultBranch = r.defaultBranch ?? 'main';
  if (!isValidBranchName(defaultBranch)) problems.push('defaultBranch is not a valid branch name');

  /** @type {string|null} */
  let sshKeyPath = null;
  const hasKey = r.sshKeyPath !== undefined && r.sshKeyPath !== null;
  if (hasKey) {
    const raw = r.sshKeyPath;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed === '') problems.push('sshKeyPath must be a non-empty string');
    else if (trimmed.includes("'")) problems.push('sshKeyPath must not contain a single quote');
    else if (!path.isAbsolute(trimmed)) problems.push('sshKeyPath must be an absolute path');
    else {
      const resolved = path.resolve(trimmed);
      if (sshKeysDir && !(isSameOrInside(resolved, sshKeysDir) && resolved !== path.resolve(sshKeysDir))) {
        problems.push(`sshKeyPath must be inside SSH_KEYS_DIR (${sshKeysDir})`);
      } else if (checkKeyFile && !fs.existsSync(resolved)) {
        problems.push(`sshKeyPath does not exist: ${resolved}`);
      } else {
        sshKeyPath = resolved;
      }
    }
  }

  if (urlCheck.ok) {
    if (urlCheck.kind === 'ssh' && !hasKey) problems.push('ssh repos need their own credential: set sshKeyPath');
    if (urlCheck.kind !== 'ssh' && hasKey) problems.push('sshKeyPath only applies to ssh URLs');
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    repo: {
      id: /** @type {string} */ (r.id),
      url: /** @type {string} */ (r.url),
      kind: /** @type {'https'|'ssh'|'local'} */ (urlCheck.ok && urlCheck.kind),
      defaultBranch: /** @type {string} */ (defaultBranch),
      sshKeyPath,
    },
  };
}

/**
 * Validate a repo token. The error never contains the value.
 * @param {unknown} token
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
export function validateToken(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: `token must be 1-${MAX_TOKEN_LENGTH} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(token)) return { ok: false, error: 'token must not contain whitespace or control characters' };
  return { ok: true, token };
}
