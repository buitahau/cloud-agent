// src/repoImport.js
// `node src/cli.js import <file>`: import a repos.json + the token env vars it names into an EMPTY repo database.
// All or nothing (one transaction). Never puts token values in messages. The service itself never reads repos.json.

import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';
import { validateRepoInput, validateToken } from './lib/repoValidate.js';

/** meta key set (refreshed) by every import, even of 0 repos; informational only. */
export const META_IMPORTED = 'imported_from_repos_json_at';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown when a repos file cannot be imported. Nothing was written. */
export class ImportError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Import of repos.json failed (nothing was imported):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ImportError';
    /** @type {string[]} */
    this.problems = problems;
  }
}

/**
 * @typedef {import('./lib/repoValidate.js').ValidRepo & { token: string|null, tokenEnv: string|null }} ImportRepo
 */

/**
 * Read + validate the repos file. Collects problems instead of throwing.
 *
 * Shape:
 *   {
 *     "repos": [
 *       { "id": "web", "url": "https://github.com/org/web.git", "defaultBranch": "dev",
 *         "auth": { "tokenEnv": "GIT_TOKEN_WEB" } },
 *       { "id": "api", "url": "git@github.com:org/api.git", "auth": { "sshKeyPath": "/run/ssh-keys/id_api" } }
 *     ]
 *   }
 * A "workspaceRoot" field is returned (resolved against cwd) but not used: WORKSPACE_ROOT decides.
 *
 * @param {string} file  absolute path
 * @param {Record<string, string|undefined>} env  where auth.tokenEnv values are read from
 * @param {{ cwd: string, allowLocal: boolean, sshKeysDir: string|null }} opts
 * @returns {{ found: boolean, workspaceRoot: string|null, repos: ImportRepo[], tokenEnvNames: string[], problems: string[] }}
 */
export function loadReposFile(file, env, { cwd, allowLocal, sshKeysDir }) {
  /** @type {{ found: boolean, workspaceRoot: string|null, repos: ImportRepo[], tokenEnvNames: string[], problems: string[] }} */
  const out = { found: true, workspaceRoot: null, repos: [], tokenEnvNames: [], problems: [] };
  const { problems } = out;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // EISDIR: a directory at that path (Docker creates one for a missing bind-mount source).
    if (err?.code === 'ENOENT' || err?.code === 'EISDIR') return { ...out, found: false };
    problems.push(`could not read ${file} (${err?.code ?? err?.message})`);
    return out;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    problems.push(`${file} is not valid JSON: ${err.message}`);
    return out;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    problems.push(`${file} must contain a JSON object with a "repos" array`);
    return out;
  }
  if (typeof doc.workspaceRoot === 'string' && doc.workspaceRoot.trim()) {
    out.workspaceRoot = path.resolve(cwd, doc.workspaceRoot.trim());
  }
  if (!Array.isArray(doc.repos)) {
    problems.push(`${file}: "repos" must be an array`);
    return out;
  }

  const seen = new Set();
  const names = new Set();
  doc.repos.forEach((r, i) => {
    const where = `repos[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = r.id;
    const label = typeof id === 'string' ? `${where} "${id}"` : where;
    const before = problems.length;
    if (typeof id === 'string' && seen.has(id)) problems.push(`${label}: duplicate id`);
    if (typeof id === 'string') seen.add(id);

    const auth = r.auth ?? null;
    if (auth !== null && (typeof auth !== 'object' || Array.isArray(auth))) problems.push(`${label}: auth must be an object`);
    const a = auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : {};

    const sshKeyPath = a.sshKeyPath === undefined
      ? undefined
      : (typeof a.sshKeyPath === 'string' ? expandHome(a.sshKeyPath.trim()) : a.sshKeyPath);
    const v = validateRepoInput({ id, url: r.url, defaultBranch: r.defaultBranch, sshKeyPath }, { allowLocal, sshKeysDir, checkKeyFile: true });
    if (!v.ok) for (const p of v.problems) problems.push(`${label}: ${p.replace(/\bsshKeyPath\b/g, 'auth.sshKeyPath')}`);

    let tokenEnv = null;
    let token = null;
    if (a.tokenEnv !== undefined) {
      if (typeof a.tokenEnv !== 'string' || !ENV_NAME_RE.test(a.tokenEnv)) {
        problems.push(`${label}: auth.tokenEnv must be an environment variable name`);
      } else {
        tokenEnv = a.tokenEnv;
        names.add(tokenEnv);
        const val = env[tokenEnv];
        const trimmed = typeof val === 'string' ? val.trim() : '';
        if (trimmed === '') {
          problems.push(`${label}: environment variable ${tokenEnv} (auth.tokenEnv) is not set`);
        } else {
          const t = validateToken(trimmed);
          if (t.ok) token = t.token;
          else problems.push(`${label}: environment variable ${tokenEnv} (auth.tokenEnv) ${t.error}`);
        }
      }
    }

    // validateRepoInput already reports sshKeyPath on non-ssh and a missing key on ssh.
    const kind = v.ok ? v.repo.kind : null;
    if (kind === 'https' && a.tokenEnv === undefined) problems.push(`${label}: https repos need their own credential: set auth.tokenEnv`);
    if (kind === 'ssh' && a.tokenEnv !== undefined) problems.push(`${label}: auth.tokenEnv only applies to https URLs`);
    if (kind === 'local' && (a.tokenEnv !== undefined || a.sshKeyPath !== undefined)) problems.push(`${label}: local repos take no auth`);

    if (v.ok && problems.length === before) out.repos.push({ ...v.repo, token, tokenEnv });
  });
  out.tokenEnvNames = [...names];
  return out;
}

/**
 * Import a repos file into an EMPTY database, atomically. Used by `node src/cli.js import <file>`.
 * @param {{ store: import('./repoStore.js').RepoStore, file: string,
 *           config: Pick<import('./config.js').Config, 'workspaceRoot'|'allowLocalRepos'|'sshKeysDir'>,
 *           env: Record<string, string|undefined>, cwd?: string, log: { warn: (m: string) => void } }} opts
 * @returns {{ count: number, ids: string[] }}
 * @throws {ImportError} database not empty, file missing/invalid, token variable unset/invalid (nothing written)
 */
export function importReposFile({ store, file, config, env, cwd = process.cwd(), log }) {
  const notEmpty = (n) => new ImportError([`the database already has ${n} repo${n === 1 ? '' : 's'}; import only fills an empty database (manage repos in the admin dashboard or API)`]);
  const existing = store.count();
  if (existing > 0) throw notEmpty(existing);
  const parsed = loadReposFile(file, env, { cwd, allowLocal: config.allowLocalRepos, sshKeysDir: config.sshKeysDir });
  if (!parsed.found) throw new ImportError([`${file} not found`]);
  if (parsed.problems.length) throw new ImportError(parsed.problems);
  if (parsed.workspaceRoot && parsed.workspaceRoot !== config.workspaceRoot) {
    log.warn(`WARNING: repos.json workspaceRoot (${parsed.workspaceRoot}) is ignored; workspaces live in WORKSPACE_ROOT (${config.workspaceRoot}). Set WORKSPACE_ROOT=${parsed.workspaceRoot} to keep the existing clones.`);
  }
  store.tx(() => {
    const n = store.count();
    if (n > 0) throw notEmpty(n); // re-check under the write lock (a repo was added through the admin API meanwhile); tx rolls back
    const summary = parsed.repos.map((r) => {
      store.insertRepo(r);
      const t = r.token ? store.setToken(r.id, r.token) : null;
      return { id: r.id, kind: r.kind, token: t ? (t.hint ? `set …${t.hint}` : 'set') : null };
    });
    store.setMeta(META_IMPORTED, new Date().toISOString());
    store.insertAudit({ actor: 'cli', action: 'import', details: { file, count: summary.length, repos: summary } });
  });
  return { count: parsed.repos.length, ids: parsed.repos.map((r) => r.id) };
}
