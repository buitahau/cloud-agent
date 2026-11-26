// src/db/migrations.js
// Schema migrations, tracked in PRAGMA user_version. APPEND-ONLY: never edit or reorder a shipped entry;
// add a new string instead. Entry i (0-based) moves the schema from version i to i+1.

import { tx } from '../db.js';

/** Ordered migration SQL. Entry i moves user_version i -> i + 1. */
export const MIGRATIONS = Object.freeze([
  // 1: repos, encrypted per-repo secrets, audit log, meta (docs/SQLITE_REPOS_PLAN.md §3)
  `
CREATE TABLE repos (
  id             TEXT PRIMARY KEY,   -- immutable: URL segment, workspace dir name, part of the AAD
  url            TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('https','ssh','local')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  ssh_key_path   TEXT,               -- ssh only
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE repo_secrets (           -- one row per (repo, secret); 'token' now, 'ssh_key' possible later
  repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (name IN ('token')),
  alg        TEXT NOT NULL DEFAULT 'A256GCM',
  key_id     TEXT NOT NULL,
  iv         BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag        BLOB NOT NULL,
  hint       TEXT NOT NULL,           -- last 4 chars, display only
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);
CREATE INDEX repo_secrets_key_id ON repo_secrets(key_id);   -- rotation sweep

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  ip      TEXT,
  action  TEXT NOT NULL,
  repo_id TEXT,
  details TEXT NOT NULL DEFAULT '{}'  -- JSON, never secrets
);
CREATE INDEX audit_log_repo ON audit_log(repo_id, id);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- e.g. imported_from_repos_json_at
`,
]);

/** Schema version this code expects (= number of migrations). */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Thrown when the database cannot be brought to SCHEMA_VERSION (e.g. it is newer than the code). */
export class MigrationError extends Error {
  /**
   * @param {string} message
   * @param {{ dbVersion?: number, codeVersion?: number }} [extra]
   */
  constructor(message, extra) {
    super(message);
    this.name = 'MigrationError';
    Object.assign(this, extra);
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} PRAGMA user_version
 */
export function getSchemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Bring the schema up to migrations.length. Each step runs in its own tx() that re-reads user_version, execs
 * the SQL, then sets user_version = i + 1. A failing step rolls back only that step and throws; earlier steps
 * stay applied.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<string>} [migrations]
 * @returns {{ from: number, to: number }}
 * @throws {MigrationError} if the database is newer than the code
 * @throws {Error} the SQLite error of a failing step
 */
export function migrate(db, migrations = MIGRATIONS) {
  const target = migrations.length;
  const from = getSchemaVersion(db);
  if (from > target) {
    throw new MigrationError(
      `database schema version ${from} is newer than this code supports (${target}); refusing to start (was an older image deployed?)`,
      { dbVersion: from, codeVersion: target },
    );
  }
  for (;;) {
    const done = tx(db, () => {
      const v = getSchemaVersion(db);
      if (v >= target) return true;
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      return false;
    });
    if (done) break;
  }
  return { from, to: getSchemaVersion(db) };
}
