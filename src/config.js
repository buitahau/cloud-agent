// src/config.js
// Load + validate configuration. PURE: takes an env object, never reads process.env
// itself and never calls dotenv (src/index.js does `dotenv.config()` first).
// Fail fast: any problem -> throw ConfigError listing ALL problems found.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSameOrInside } from './lib/repoValidate.js';
import { parseKeyRingEnv } from './secrets.js';
import { SECRET_ENV_PATTERN } from './lib/secretEnv.js';

/** Directory holding this service's code (src/..). */
const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * @property {string}      dbFile               DB_FILE resolved to an absolute path (default "./data/cloud-agent.db")
 * @property {string}      workspaceRoot        WORKSPACE_ROOT (default "./workspaces"), absolute; repos are cloned to <workspaceRoot>/<id>
 * @property {import('./secrets.js').KeyRing} keyRing  from MASTER_KEY (+ MASTER_KEY_PREVIOUS); never holds raw key strings
 * @property {boolean}     allowLocalRepos      ALLOW_LOCAL_REPOS (default false): allow absolute-path / file:// repos
 * @property {boolean}     trustProxy           TRUST_PROXY (default false): trust X-Forwarded-For/-Proto/-Host from a
 *                                              loopback/private-network proxy (audit ip, admin CSRF origin check)
 * @property {string}      sshKeysDir           SSH_KEYS_DIR (default "/run/ssh-keys", ~-expanded): ssh keys must live inside it
 * @property {string}      claudeBin            CLAUDE_BIN (default "claude")
 * @property {string}      claudePermissionMode CLAUDE_PERMISSION_MODE (default "bypassPermissions"), one of PERMISSION_MODES
 * @property {number}      claudeMaxTurns       CLAUDE_MAX_TURNS (default 50), integer >= 1
 * @property {boolean}     claudeAuthProbe      CLAUDE_AUTH_PROBE (default true); accepts true/false/1/0/yes/no (case-insensitive)
 * @property {number}      jobTimeoutMs         JOB_TIMEOUT_SECONDS (default 1800) * 1000, integer seconds >= 1
 * @property {number}      gitTimeoutMs         GIT_TIMEOUT_SECONDS (default 300) * 1000, integer seconds >= 1
 * @property {number}      logsTailLines        LOGS_TAIL_LINES (default 50), integer >= 1
 * @property {number}      port                 PORT (default 8080), integer 0..65535 (0 = ephemeral, used by tests)
 * @property {string}      apiKey               API_KEY (required, non-empty)
 * @property {number}      maxConcurrentJobs    MAX_CONCURRENT_JOBS (default 1, 1..32). Never more than one job per repo.
 * @property {string|null} jobsFile             JOBS_FILE resolved to an absolute path; null = in-memory only
 * @property {number}      jobRetentionMax      JOB_RETENTION_MAX (default 1000): finished jobs kept
 * @property {string}      adminUser            ADMIN_USER (default "admin")
 * @property {string|null} adminPassword        ADMIN_PASSWORD; null = admin dashboard disabled
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

/** Env vars that are no longer read (single-repo era, repos.json era). Setting one fails startup. */
const RETIRED_VARS = Object.freeze(['REPO_URL', 'REPO_BRANCH', 'WORKSPACE_DIR', 'GIT_SSH_KEY_PATH', 'REPOS_FILE', 'GIT_TOKEN']);

/** @param {string} name @returns {boolean} REPOS_FILE / GIT_TOKEN / GIT_TOKEN_*: read only by `node src/cli.js import`. */
export function isRepoImportVar(name) {
  return name === 'REPOS_FILE' || name === 'GIT_TOKEN' || SECRET_ENV_PATTERN.test(name);
}

/**
 * Copy of env without the repos.json-era vars (for `node src/cli.js import`, which reads token vars itself).
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string|undefined>}
 */
export function withoutRepoImportVars(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !isRepoImportVar(k)));
}

/**
 * Build and validate the config from an env-like object. Env only: never reads files (repos live in the
 * database, see src/repoStore.js).
 *
 * Rules:
 *  - Treat empty strings / whitespace-only env values as "unset". Trim all values.
 *  - Required: API_KEY and MASTER_KEY (base64 of 32 bytes).
 *  - Integers: parse with Number(); must be Number.isInteger and within range, else problem.
 *  - Never put secret values (API key, admin password, master keys) into error messages.
 *  - Retired vars (RETIRED_VARS, GIT_TOKEN_*) set to a non-blank value -> one problem naming all of them.
 *  - Return Object.freeze()d Config.
 *
 * @param {Record<string, string|undefined>} env  usually process.env
 * @param {{ cwd?: string }} [opts]                cwd used to resolve relative paths (default process.cwd())
 * @returns {Config}
 * @throws {ConfigError}
 */
export function loadConfig(env, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
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

  const apiKey = get('API_KEY');
  if (apiKey === null) problems.push('API_KEY is required');

  // Values never appear in the message (GIT_TOKEN* hold secrets).
  const retired = Object.keys(env)
    .filter((k) => (RETIRED_VARS.includes(k) || SECRET_ENV_PATTERN.test(k)) && get(k) !== null)
    .sort();
  if (retired.length) {
    const many = retired.length > 1;
    problems.unshift(`${retired.join(', ')} ${many ? 'are' : 'is'} no longer read: repos and their tokens are stored in the database (DB_FILE). `
      + `Remove ${many ? 'them' : 'it'} from .env (or the environment)${retired.includes('REPOS_FILE') ? ' and the repos.json mount from docker-compose.yml' : ''}; `
      + 'add repos in the admin dashboard or API, or import a repos.json into an empty database with: node src/cli.js import <file>');
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
  const maxConcurrentJobs = int('MAX_CONCURRENT_JOBS', 1, 1, 32);
  const jobRetentionMax = int('JOB_RETENTION_MAX', 1000, 1, 1_000_000);
  const jobsFileRaw = get('JOBS_FILE');
  const jobsFile = jobsFileRaw === null ? null : path.resolve(cwd, jobsFileRaw);

  const adminUser = get('ADMIN_USER') ?? 'admin';
  if (adminUser.includes(':')) problems.push('ADMIN_USER must not contain ":"');
  const adminPassword = get('ADMIN_PASSWORD');
  if (adminPassword !== null) {
    if (adminPassword.length < 8) problems.push('ADMIN_PASSWORD must be at least 8 characters');
    if (apiKey !== null && adminPassword === apiKey) problems.push('ADMIN_PASSWORD must differ from API_KEY');
  }

  const dbFile = path.resolve(cwd, get('DB_FILE') ?? './data/cloud-agent.db');
  const workspaceRoot = path.resolve(cwd, get('WORKSPACE_ROOT') ?? './workspaces');
  // git clean -fdx inside a workspace that contains the service would delete the service.
  if ([path.resolve(cwd), SERVICE_DIR].some((dir) => isSameOrInside(dir, workspaceRoot))) {
    problems.push(`WORKSPACE_ROOT must not be the service directory or one of its parents (${workspaceRoot})`);
  }
  if (isSameOrInside(dbFile, workspaceRoot)) problems.push(`DB_FILE must not be inside WORKSPACE_ROOT (${dbFile})`);
  const allowLocalRepos = bool('ALLOW_LOCAL_REPOS', false);
  const trustProxy = bool('TRUST_PROXY', false);
  const sshKeysDir = path.resolve(cwd, expandHome(get('SSH_KEYS_DIR') ?? '/run/ssh-keys'));

  const masterKey = get('MASTER_KEY');
  if (masterKey === null) {
    problems.push('MASTER_KEY is required: it encrypts the repo tokens in DB_FILE (generate one with: openssl rand -base64 32)');
  }
  const { keyRing, problems: keyProblems } = parseKeyRingEnv({
    masterKey, masterKeyPrevious: get('MASTER_KEY_PREVIOUS'), apiKey, adminPassword,
  });
  problems.push(...keyProblems);

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    dbFile,
    workspaceRoot,
    keyRing: /** @type {import('./secrets.js').KeyRing} */ (keyRing),
    allowLocalRepos,
    trustProxy,
    sshKeysDir,
    claudeBin: get('CLAUDE_BIN') ?? 'claude',
    claudePermissionMode,
    claudeMaxTurns,
    claudeAuthProbe,
    jobTimeoutMs: jobTimeoutSeconds * 1000,
    gitTimeoutMs: gitTimeoutSeconds * 1000,
    logsTailLines,
    port,
    apiKey: /** @type {string} */ (apiKey),
    maxConcurrentJobs,
    jobsFile,
    jobRetentionMax,
    adminUser,
    adminPassword,
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
 * Copy of the config safe to log: apiKey and adminPassword replaced by "***" (or null if unset); the key ring
 * is replaced by masterKey / masterKeyPrevious showing only key ids.
 * @param {Config} config
 * @returns {Record<string, unknown>}
 */
export function redactConfig(config) {
  const mask = (v) => (v ? '***' : null);
  const { keyRing, ...rest } = config;
  return {
    ...rest,
    apiKey: mask(config.apiKey),
    adminPassword: mask(config.adminPassword),
    masterKey: keyRing ? `*** (key id ${keyRing.currentKeyId})` : null,
    masterKeyPrevious: keyRing ? keyRing.keyIds.slice(1).map((k) => `*** (key id ${k})`) : [],
  };
}
