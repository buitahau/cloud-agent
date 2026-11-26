// src/repoStore.js
// Repos and their encrypted tokens in SQLite (tables from src/db/migrations.js), plus the startup helpers that
// verify/rotate stored secrets and re-validate stored repos. Write methods never open a transaction: callers
// wrap them in store.tx(fn) (tx() cannot nest). Never puts token values in error messages or return values
// other than getToken().

import fs from 'node:fs';
import { tx } from './db.js';
import { encryptSecret, decryptSecret, needsRotation, reencryptSecret, originOf, SecretDecryptError } from './secrets.js';
import { validateRepoInput, validateToken } from './lib/repoValidate.js';

/** Name of the per-repo https token in repo_secrets. */
export const TOKEN = 'token';

/**
 * @typedef {Object} RepoRecord
 * @property {string} id
 * @property {string} url
 * @property {'https'|'ssh'|'local'} kind
 * @property {string} defaultBranch
 * @property {string|null} sshKeyPath
 * @property {boolean} enabled
 * @property {string} createdAt  ISO timestamp
 * @property {string} updatedAt  ISO timestamp
 */

/**
 * AAD for a repo's token. A non-https URL (e.g. a tampered row) makes decryption fail closed.
 * @param {string} repoId
 * @param {string} url
 */
function aad(repoId, url) {
  try {
    return { repoId, name: TOKEN, origin: originOf(url) };
  } catch {
    throw new SecretDecryptError('malformed', 'repo URL is not https');
  }
}

/** @returns {RepoRecord} */
function toRecord(row) {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind,
    defaultBranch: row.default_branch,
    sshKeyPath: row.ssh_key_path ?? null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the store. Call AFTER migrate(db).
 * @param {{ db: import('node:sqlite').DatabaseSync, keyRing: import('./secrets.js').KeyRing, now?: () => string }} opts
 */
export function createRepoStore({ db, keyRing, now = () => new Date().toISOString() }) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM repos'),
    list: db.prepare('SELECT * FROM repos ORDER BY rowid'),
    get: db.prepare('SELECT * FROM repos WHERE id = ?'),
    insertRepo: db.prepare(
      'INSERT INTO repos (id,url,kind,default_branch,ssh_key_path,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)',
    ),
    secret: db.prepare('SELECT s.*, r.url FROM repo_secrets s JOIN repos r ON r.id = s.repo_id WHERE s.repo_id = ? AND s.name = ?'),
    upsertSecret: db.prepare(
      `INSERT INTO repo_secrets (repo_id,name,alg,key_id,iv,ciphertext,tag,hint,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo_id,name) DO UPDATE SET alg=excluded.alg,key_id=excluded.key_id,iv=excluded.iv,
         ciphertext=excluded.ciphertext,tag=excluded.tag,hint=excluded.hint,updated_at=excluded.updated_at`,
    ),
    allSecrets: db.prepare('SELECT s.*, r.url FROM repo_secrets s JOIN repos r ON r.id = s.repo_id ORDER BY r.rowid, s.name'),
    updateCipher: db.prepare('UPDATE repo_secrets SET alg=?, key_id=?, iv=?, ciphertext=?, tag=? WHERE repo_id=? AND name=?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    insertAudit: db.prepare('INSERT INTO audit_log (at,actor,ip,action,repo_id,details) VALUES (?,?,?,?,?,?)'),
  };

  return {
    /** @returns {number} */
    count() {
      return Number(q.count.get().n);
    },
    /** @returns {RepoRecord[]} insertion order */
    list() {
      return q.list.all().map(toRecord);
    },
    /** @param {string} id @returns {RepoRecord|null} */
    get(id) {
      const row = q.get.get(id);
      return row ? toRecord(row) : null;
    },
    /** @param {string} id @returns {{ set: true, hint: string, updatedAt: string } | null} */
    tokenInfo(id) {
      const row = q.secret.get(id, TOKEN);
      return row ? { set: true, hint: row.hint, updatedAt: row.updated_at } : null;
    },
    /**
     * @param {string} id
     * @returns {string|null} null when no token is stored
     * @throws {SecretDecryptError}
     */
    getToken(id) {
      const row = q.secret.get(id, TOKEN);
      if (!row) return null;
      return decryptSecret(keyRing, row, aad(id, row.url));
    },
    /** @param {string} key @returns {string|null} */
    getMeta(key) {
      const row = q.getMeta.get(key);
      return row ? row.value : null;
    },

    /** @param {import('./lib/repoValidate.js').ValidRepo} repo  validated; no transaction opened */
    insertRepo(repo) {
      const t = now();
      q.insertRepo.run(repo.id, repo.url, repo.kind, repo.defaultBranch, repo.sshKeyPath ?? null, t, t);
    },
    /**
     * Encrypt and store (or replace) the https token of a repo. No transaction opened.
     * @param {string} id
     * @param {string} token
     * @returns {{ hint: string, updatedAt: string }}
     * @throws {TypeError} invalid token, unknown repo, or non-https repo (message never contains the token)
     */
    setToken(id, token) {
      const v = validateToken(token);
      if (!v.ok) throw new TypeError(v.error);
      const repo = q.get.get(id);
      if (!repo) throw new TypeError(`unknown repo "${id}"`);
      if (repo.kind !== 'https') throw new TypeError(`repo "${id}" is not an https repo; tokens only apply to https URLs`);
      const enc = encryptSecret(keyRing, v.token, { repoId: id, name: TOKEN, origin: originOf(repo.url) });
      const updatedAt = now();
      q.upsertSecret.run(id, TOKEN, enc.alg, enc.key_id, enc.iv, enc.ciphertext, enc.tag, enc.hint, updatedAt);
      return { hint: enc.hint, updatedAt };
    },
    /** @param {string} key @param {string} value */
    setMeta(key, value) {
      q.setMeta.run(key, value);
    },
    /** @param {{ actor: string, action: string, repoId?: string|null, ip?: string|null, details?: object }} e  never secrets */
    insertAudit({ actor, action, repoId = null, ip = null, details = {} }) {
      q.insertAudit.run(now(), actor, ip, action, repoId, JSON.stringify(details));
    },

    /** @returns {{ repoId: string, name: string, reason: string }[]} every stored secret that cannot be decrypted */
    verifySecrets() {
      const failures = [];
      for (const row of q.allSecrets.all()) {
        try {
          decryptSecret(keyRing, row, aad(row.repo_id, row.url));
        } catch (err) {
          failures.push({ repoId: row.repo_id, name: row.name, reason: err instanceof SecretDecryptError ? err.reason : 'error' });
        }
      }
      return failures;
    },
    /**
     * Re-encrypt every secret not on the current key. Leaves hint and updated_at alone. No transaction opened.
     * @returns {{ count: number, fromKeyIds: string[] }}
     */
    rotateSecrets() {
      let count = 0;
      const from = new Set();
      for (const row of q.allSecrets.all()) {
        if (!needsRotation(keyRing, row)) continue;
        const enc = reencryptSecret(keyRing, row, aad(row.repo_id, row.url));
        q.updateCipher.run(enc.alg, enc.key_id, enc.iv, enc.ciphertext, enc.tag, row.repo_id, row.name);
        from.add(row.key_id);
        count++;
      }
      return { count, fromKeyIds: [...from] };
    },

    /**
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    tx(fn) {
      return tx(db, fn);
    },
  };
}

/** @typedef {ReturnType<typeof createRepoStore>} RepoStore */

/** Thrown at startup when stored secrets cannot be decrypted with the configured keys. */
export class SecretCheckError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Stored secrets cannot be decrypted (check MASTER_KEY / MASTER_KEY_PREVIOUS):\n  - ${problems.join('\n  - ')}`);
    this.name = 'SecretCheckError';
    this.problems = problems;
  }
}

/**
 * Startup: every stored secret must decrypt; then re-encrypt the ones on a previous key (one tx, audited).
 * @param {{ store: RepoStore, keyRing: import('./secrets.js').KeyRing, log?: { info: (m: string) => void, warn: (m: string) => void } }} opts
 * @returns {{ rotated: number }}
 * @throws {SecretCheckError}
 */
export function verifyAndRotateSecrets({ store, keyRing, log = { info: console.log, warn: console.warn } }) {
  const failures = store.verifySecrets();
  if (failures.length) {
    throw new SecretCheckError(failures.map((f) =>
      `repo "${f.repoId}": ${f.name} cannot be decrypted with MASTER_KEY/MASTER_KEY_PREVIOUS (${f.reason})`));
  }
  const r = store.tx(() => {
    const res = store.rotateSecrets();
    if (res.count) {
      store.insertAudit({
        actor: 'system', action: 'key.rotate',
        details: { to: keyRing.currentKeyId, from: res.fromKeyIds, count: res.count },
      });
    }
    return res;
  });
  if (r.count) log.info(`Re-encrypted ${r.count} secret(s) to key ${keyRing.currentKeyId}`);
  if (keyRing.keyIds.length > 1) {
    log.warn('WARNING: MASTER_KEY_PREVIOUS is set but no stored secret uses it any more; remove it from .env once you have a backup');
  }
  return { rotated: r.count };
}

/**
 * Startup: re-validate stored repos against the current rules (ALLOW_LOCAL_REPOS, SSH_KEYS_DIR).
 * @param {Pick<RepoStore, 'list'|'tokenInfo'>} store
 * @param {{ allowLocal: boolean, sshKeysDir: string|null }} opts
 * @returns {{ problems: string[], warnings: string[] }}  problems are fatal; warnings only affect that repo's jobs
 */
export function checkStoredRepos(store, { allowLocal, sshKeysDir }) {
  const problems = [];
  const warnings = [];
  for (const rec of store.list()) {
    const v = validateRepoInput(rec, { allowLocal, sshKeysDir, checkKeyFile: false });
    if (!v.ok) {
      for (const p of v.problems) problems.push(`repo "${rec.id}": ${p}`);
      continue;
    }
    if (v.repo.kind !== rec.kind) {
      problems.push(`repo "${rec.id}": stored kind does not match its url`);
      continue;
    }
    if (rec.kind === 'ssh' && rec.sshKeyPath && !fs.existsSync(rec.sshKeyPath)) {
      warnings.push(`repo "${rec.id}": sshKeyPath does not exist: ${rec.sshKeyPath} (its jobs will fail)`);
    }
    if (rec.kind === 'https' && !store.tokenInfo(rec.id)) {
      warnings.push(`repo "${rec.id}": no token stored (its jobs will fail to authenticate)`);
    }
  }
  return { problems, warnings };
}
