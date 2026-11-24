// src/config.js
// Load + validate configuration. PURE: takes an env object, never reads process.env
// itself and never calls dotenv (src/index.js does `dotenv.config()` first).
// Fail fast: any problem -> throw ConfigError listing ALL problems found.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isValidBranchName } from './lib/validate.js';

/** Allowed values for --permission-mode (from `claude --help`, v2.x). */
export const PERMISSION_MODES = Object.freeze([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

/**
 * @typedef {Object} Config
 * @property {string}      repoUrl              REPO_URL (required)
 * @property {string}      repoBranch           REPO_BRANCH (default "main"); must pass isValidBranchName()
 * @property {string}      workspaceDir         WORKSPACE_DIR resolved to an ABSOLUTE path (default "./workspace", resolved against cwd)
 * @property {string|null} gitSshKeyPath        GIT_SSH_KEY_PATH with leading "~" expanded to os.homedir(); null if unset/empty
 * @property {string|null} gitToken             GIT_TOKEN; null if unset/empty
 * @property {string|null} claudeOauthToken     CLAUDE_CODE_OAUTH_TOKEN; null if unset/empty (then an existing ~/.claude login must work)
 * @property {string}      claudeBin            CLAUDE_BIN (default "claude")
 * @property {string}      claudePermissionMode CLAUDE_PERMISSION_MODE (default "bypassPermissions"), one of PERMISSION_MODES
 * @property {number}      claudeMaxTurns       CLAUDE_MAX_TURNS (default 50), integer >= 1
 * @property {boolean}     claudeAuthProbe      CLAUDE_AUTH_PROBE (default true); accepts true/false/1/0/yes/no (case-insensitive)
 * @property {number}      jobTimeoutMs         JOB_TIMEOUT_SECONDS (default 1800) * 1000, integer seconds >= 1
 * @property {number}      gitTimeoutMs         GIT_TIMEOUT_SECONDS (default 300) * 1000, integer seconds >= 1
 * @property {number}      logsTailLines        LOGS_TAIL_LINES (default 50), integer >= 1
 * @property {number}      port                 PORT (default 8080), integer 0..65535 (0 = ephemeral, used by tests)
 * @property {string}      apiKey               API_KEY (required, non-empty)
 */

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    /** @type {string[]} */
    this.problems = problems;
  }
}

/**
 * Build and validate the config from an env-like object.
 *
 * Rules:
 *  - Treat empty strings / whitespace-only as "unset". Trim all values.
 *  - Required: REPO_URL, API_KEY.
 *  - If GIT_SSH_KEY_PATH is set, the file must exist (fs.existsSync after ~ expansion) -> else problem.
 *  - Do NOT require either git auth method (public https repos / local file:// paths need none;
 *    tests use local bare repos).
 *  - Integers: parse with Number(); must be Number.isInteger and within range, else problem.
 *  - Never put secret values (tokens, API key) into error messages.
 *  - Return Object.freeze()d Config.
 *
 * @param {Record<string, string|undefined>} env  usually process.env
 * @param {{ cwd?: string }} [opts]                cwd used to resolve WORKSPACE_DIR (default process.cwd())
 * @returns {Config}
 * @throws {ConfigError}
 */
export function loadConfig(env, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  const get = (key) => {
    const v = env[key];
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
  };
  const int = (key, def, min, max = Number.MAX_SAFE_INTEGER) => {
    const raw = get(key);
    if (raw === null) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
      return def;
    }
    return n;
  };
  const bool = (key, def) => {
    const raw = get(key);
    if (raw === null) return def;
    const v = raw.toLowerCase();
    if (['true', '1', 'yes'].includes(v)) return true;
    if (['false', '0', 'no'].includes(v)) return false;
    problems.push(`${key} must be one of true/false/1/0/yes/no (got "${raw}")`);
    return def;
  };

  const repoUrl = get('REPO_URL');
  if (repoUrl === null) problems.push('REPO_URL is required');

  const apiKey = get('API_KEY');
  if (apiKey === null) problems.push('API_KEY is required');

  const repoBranch = get('REPO_BRANCH') ?? 'main';
  if (!isValidBranchName(repoBranch)) problems.push(`REPO_BRANCH is not a valid branch name (got "${repoBranch}")`);

  const workspaceDir = path.resolve(opts.cwd ?? process.cwd(), get('WORKSPACE_DIR') ?? './workspace');

  let gitSshKeyPath = get('GIT_SSH_KEY_PATH');
  if (gitSshKeyPath !== null) {
    gitSshKeyPath = expandHome(gitSshKeyPath);
    if (!fs.existsSync(gitSshKeyPath)) problems.push(`GIT_SSH_KEY_PATH does not exist: ${gitSshKeyPath}`);
  }

  const claudePermissionMode = get('CLAUDE_PERMISSION_MODE') ?? 'bypassPermissions';
  if (!PERMISSION_MODES.includes(claudePermissionMode)) {
    problems.push(`CLAUDE_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')} (got "${claudePermissionMode}")`);
  }

  const claudeMaxTurns = int('CLAUDE_MAX_TURNS', 50, 1);
  const jobTimeoutSeconds = int('JOB_TIMEOUT_SECONDS', 1800, 1);
  const gitTimeoutSeconds = int('GIT_TIMEOUT_SECONDS', 300, 1);
  const logsTailLines = int('LOGS_TAIL_LINES', 50, 1);
  const port = int('PORT', 8080, 0, 65535);
  const claudeAuthProbe = bool('CLAUDE_AUTH_PROBE', true);

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    repoUrl: /** @type {string} */ (repoUrl),
    repoBranch,
    workspaceDir,
    gitSshKeyPath,
    gitToken: get('GIT_TOKEN'),
    claudeOauthToken: get('CLAUDE_CODE_OAUTH_TOKEN'),
    claudeBin: get('CLAUDE_BIN') ?? 'claude',
    claudePermissionMode,
    claudeMaxTurns,
    claudeAuthProbe,
    jobTimeoutMs: jobTimeoutSeconds * 1000,
    gitTimeoutMs: gitTimeoutSeconds * 1000,
    logsTailLines,
    port,
    apiKey: /** @type {string} */ (apiKey),
  });
}

/**
 * Expand a leading "~" or "~/" to the home directory. Other strings returned unchanged.
 * @param {string} p
 * @param {string} [home] defaults to os.homedir()
 * @returns {string}
 */
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Copy of the config safe to log: gitToken, claudeOauthToken, apiKey replaced by "***" (or null if unset).
 * @param {Config} config
 * @returns {Record<string, unknown>}
 */
export function redactConfig(config) {
  const mask = (v) => (v ? '***' : null);
  return {
    ...config,
    gitToken: mask(config.gitToken),
    claudeOauthToken: mask(config.claudeOauthToken),
    apiKey: mask(config.apiKey),
  };
}
