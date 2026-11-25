// src/config.js
// Load + validate configuration. PURE: takes an env object, never reads process.env
// itself and never calls dotenv (src/index.js does `dotenv.config()` first).
// Fail fast: any problem -> throw ConfigError listing ALL problems found.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isValidBranchName, isValidRepoId, validateRepoUrl, RESERVED_REPO_IDS } from './lib/validate.js';

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
 * One target repository (from REPOS_FILE).
 * @typedef {Object} RepoConfig
 * @property {string}      id             url-safe id, used in routes (/<id>/run-agent) and as the workspace dir name
 * @property {string}      url            git remote URL (validated by validateRepoUrl)
 * @property {'https'|'ssh'|'local'} kind
 * @property {string}      defaultBranch  branch used when a job does not name one (default "main")
 * @property {string}      workspaceDir   ABSOLUTE: <workspaceRoot>/<id>
 * @property {string|null} sshKeyPath     auth.sshKeyPath, ~-expanded (ssh URLs only)
 * @property {string|null} tokenEnv       auth.tokenEnv — the NAME of the env var holding the token (https URLs only)
 * @property {string|null} token          value of that env var
 */

/**
 * @typedef {Object} Config
 * @property {string}      reposFile            REPOS_FILE resolved to an absolute path (default "./repos.json")
 * @property {string}      workspaceRoot        absolute; repos are cloned to <workspaceRoot>/<id>
 * @property {ReadonlyArray<RepoConfig>} repos  at least one
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

/** Env vars from the single-repo version; setting any of them is a mistake now. */
const LEGACY_VARS = Object.freeze(['REPO_URL', 'REPO_BRANCH', 'WORKSPACE_DIR', 'GIT_TOKEN', 'GIT_SSH_KEY_PATH']);

/**
 * Build and validate the config from an env-like object plus the repos file it points at.
 *
 * Rules:
 *  - Treat empty strings / whitespace-only env values as "unset". Trim all values.
 *  - Required: API_KEY, and a readable REPOS_FILE (default ./repos.json) with at least one repo.
 *  - Every remote repo needs its OWN credential: https -> auth.tokenEnv (env var must be set),
 *    ssh -> auth.sshKeyPath (file must exist). Local paths take no auth. There is no global fallback.
 *  - Integers: parse with Number(); must be Number.isInteger and within range, else problem.
 *  - Never put secret values (tokens, API key, admin password) into error messages.
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

  const reposFile = path.resolve(cwd, get('REPOS_FILE') ?? './repos.json');
  const { workspaceRoot, repos } = loadReposFile(reposFile, env, cwd, problems);

  // A repo may legitimately name e.g. GIT_TOKEN as its auth.tokenEnv; only flag vars nothing refers to.
  const referenced = new Set(repos.map((r) => r.tokenEnv).filter(Boolean));
  const legacy = LEGACY_VARS.filter((k) => get(k) !== null && !referenced.has(k));
  if (legacy.length) {
    problems.unshift(`${legacy.join(', ')} ${legacy.length > 1 ? 'are' : 'is'} no longer supported; define repos in REPOS_FILE (see repos.example.json)`);
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

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    reposFile,
    workspaceRoot: /** @type {string} */ (workspaceRoot),
    repos: Object.freeze(repos.map((r) => Object.freeze(r))),
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
 * Read + validate the repos file. Pushes problems instead of throwing.
 *
 * Shape:
 *   {
 *     "workspaceRoot": "./workspaces",          // optional, resolved against cwd
 *     "repos": [
 *       { "id": "web", "url": "https://github.com/org/web.git", "defaultBranch": "dev",
 *         "auth": { "tokenEnv": "GIT_TOKEN_WEB" } },
 *       { "id": "api", "url": "git@github.com:org/api.git", "auth": { "sshKeyPath": "~/.ssh/id_api" } }
 *     ]
 *   }
 *
 * @param {string} file
 * @param {Record<string, string|undefined>} env
 * @param {string} cwd
 * @param {string[]} problems
 * @returns {{ workspaceRoot: string|null, repos: RepoConfig[] }}
 */
function loadReposFile(file, env, cwd, problems) {
  const out = { workspaceRoot: null, repos: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(err?.code === 'ENOENT'
      ? `REPOS_FILE not found: ${file} (copy repos.example.json to get started)`
      : `REPOS_FILE could not be read: ${file} (${err?.code ?? err?.message})`);
    return out;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    problems.push(`REPOS_FILE is not valid JSON: ${err.message}`);
    return out;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    problems.push('REPOS_FILE must contain a JSON object with a "repos" array');
    return out;
  }
  if (doc.workspaceRoot !== undefined && (typeof doc.workspaceRoot !== 'string' || doc.workspaceRoot.trim() === '')) {
    problems.push('REPOS_FILE: workspaceRoot must be a non-empty string');
  }
  const workspaceRoot = path.resolve(cwd, typeof doc.workspaceRoot === 'string' && doc.workspaceRoot.trim() ? doc.workspaceRoot.trim() : './workspaces');
  out.workspaceRoot = workspaceRoot;

  // git clean -fdx inside a workspace that contains the service would delete the service.
  if ([path.resolve(cwd), SERVICE_DIR].some((dir) => isSameOrInside(dir, workspaceRoot))) {
    problems.push(`REPOS_FILE: workspaceRoot must not be the service directory or one of its parents (${workspaceRoot})`);
  }

  if (!Array.isArray(doc.repos) || doc.repos.length === 0) {
    problems.push('REPOS_FILE: "repos" must be a non-empty array');
    return out;
  }

  const seen = new Set();
  doc.repos.forEach((r, i) => {
    const where = `REPOS_FILE repos[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = r.id;
    const label = typeof id === 'string' ? `${where} "${id}"` : where;
    if (!isValidRepoId(id)) {
      problems.push(`${label}: id must be 1-40 chars of a-z, 0-9 and "-" (not at the ends), and not one of ${RESERVED_REPO_IDS.join(', ')}`);
    } else if (seen.has(id)) {
      problems.push(`${label}: duplicate id`);
    } else {
      seen.add(id);
    }

    const urlCheck = validateRepoUrl(r.url);
    if (!urlCheck.ok) problems.push(`${label}: ${urlCheck.error}`);

    const defaultBranch = r.defaultBranch ?? 'main';
    if (!isValidBranchName(defaultBranch)) problems.push(`${label}: defaultBranch is not a valid branch name`);

    const auth = r.auth ?? null;
    if (auth !== null && (typeof auth !== 'object' || Array.isArray(auth))) {
      problems.push(`${label}: auth must be an object`);
    }
    const a = auth && typeof auth === 'object' ? auth : {};
    let sshKeyPath = null;
    let tokenEnv = null;
    let token = null;
    if (a.sshKeyPath !== undefined) {
      if (typeof a.sshKeyPath !== 'string' || a.sshKeyPath.trim() === '') {
        problems.push(`${label}: auth.sshKeyPath must be a non-empty string`);
      } else {
        sshKeyPath = expandHome(a.sshKeyPath.trim());
        if (sshKeyPath.includes("'")) problems.push(`${label}: auth.sshKeyPath must not contain a single quote`);
        else if (!fs.existsSync(sshKeyPath)) problems.push(`${label}: auth.sshKeyPath does not exist: ${sshKeyPath}`);
      }
    }
    if (a.tokenEnv !== undefined) {
      if (typeof a.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.tokenEnv)) {
        problems.push(`${label}: auth.tokenEnv must be an environment variable name`);
      } else {
        tokenEnv = a.tokenEnv;
        const v = env[tokenEnv];
        token = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
        if (token === null) problems.push(`${label}: environment variable ${tokenEnv} (auth.tokenEnv) is not set`);
      }
    }

    if (urlCheck.ok) {
      if (urlCheck.kind === 'https') {
        if (a.tokenEnv === undefined) problems.push(`${label}: https repos need their own credential: set auth.tokenEnv`);
        if (a.sshKeyPath !== undefined) problems.push(`${label}: auth.sshKeyPath only applies to ssh URLs`);
      } else if (urlCheck.kind === 'ssh') {
        if (a.sshKeyPath === undefined) problems.push(`${label}: ssh repos need their own credential: set auth.sshKeyPath`);
        if (a.tokenEnv !== undefined) problems.push(`${label}: auth.tokenEnv only applies to https URLs`);
      } else if (a.tokenEnv !== undefined || a.sshKeyPath !== undefined) {
        problems.push(`${label}: local repos take no auth`);
      }
    }

    out.repos.push({
      id: typeof id === 'string' ? id : '',
      url: typeof r.url === 'string' ? r.url : '',
      kind: urlCheck.ok ? urlCheck.kind : 'local',
      defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : 'main',
      workspaceDir: path.join(workspaceRoot, typeof id === 'string' ? id : `invalid-${i}`),
      sshKeyPath,
      tokenEnv,
      token,
    });
  });
  return out;
}

/** True iff `child` is `parent` or lies inside it. Both absolute. */
function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
 * Copy of the config safe to log: apiKey, adminPassword and every repo token replaced by "***" (or null if unset).
 * @param {Config} config
 * @returns {Record<string, unknown>}
 */
export function redactConfig(config) {
  const mask = (v) => (v ? '***' : null);
  return {
    ...config,
    repos: (config.repos ?? []).map((r) => ({ ...r, token: mask(r.token) })),
    apiKey: mask(config.apiKey),
    adminPassword: mask(config.adminPassword),
  };
}
