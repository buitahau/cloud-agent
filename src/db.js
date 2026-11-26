// src/db.js
// Open the service's SQLite database (node:sqlite, synchronous) with safe file modes and pragmas, plus a
// small transaction helper. No schema knowledge here: see src/db/migrations.js. Not wired in until PR 2.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Databases currently inside tx(); node:sqlite's db.isTransaction needs Node >= 22.16, engines is >= 22.13. */
const IN_TX = new WeakSet();
const POSIX = process.platform !== 'win32';

/**
 * chmod 0600 if the file exists; ENOENT is ignored. No-op on Windows.
 * @param {string} file
 */
function tighten(file) {
  if (!POSIX) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/**
 * Open (creating if needed) the database file.
 *  - mkdir -p the parent dir with mode 0700 (an EXISTING dir is left as is: it may be /app/data or cwd).
 *  - Pre-create the file with mode 0600, then chmod 0600 anyway (tightens an existing file).
 *  - Pragmas: journal_mode=WAL (must report 'wal'), busy_timeout=5000, foreign_keys=ON, synchronous=NORMAL.
 *  - chmod <file>-wal / <file>-shm to 0600 if present.
 * `':memory:'` skips all file handling (tests); its journal_mode is 'memory'.
 * @param {string} file  absolute path, or ':memory:'
 * @returns {import('node:sqlite').DatabaseSync}
 * @throws {Error} `cannot open database <file>: <reason>` (cause = original error)
 */
export function openDb(file) {
  const memory = file === ':memory:';
  /** @type {import('node:sqlite').DatabaseSync | undefined} */
  let db;
  try {
    if (!memory) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      tighten(file);
    }
    db = new DatabaseSync(file);
    const { journal_mode: mode } = db.prepare('PRAGMA journal_mode=WAL').get();
    if (mode !== 'wal' && !(memory && mode === 'memory')) {
      throw new Error(`journal_mode is "${mode}", expected "wal"`);
    }
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    if (!memory) {
      tighten(`${file}-wal`);
      tighten(`${file}-shm`);
    }
  } catch (err) {
    if (db) closeDb(db);
    throw new Error(`cannot open database ${file}: ${err.message}`, { cause: err });
  }
  return db;
}

/**
 * Close the database; a second call (or an already closed db) is a no-op.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function closeDb(db) {
  try {
    db.close();
  } catch (err) {
    if (err?.code !== 'ERR_INVALID_STATE') throw err;
  }
}

/**
 * Run fn inside BEGIN IMMEDIATE ... COMMIT; on any throw, ROLLBACK and rethrow the ORIGINAL error.
 *  - fn must be synchronous: a returned thenable is rolled back and throws TypeError.
 *  - Nesting is NOT supported: tx() inside tx() on the same db throws Error('tx() cannot be nested').
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 * @throws {Error} whatever fn threw (after rollback), or the nesting/async errors above
 */
export function tx(db, fn) {
  if (IN_TX.has(db)) throw new Error('tx() cannot be nested');
  db.exec('BEGIN IMMEDIATE');
  IN_TX.add(db);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new TypeError('tx() callback must be synchronous');
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back by SQLite */
    }
    throw err;
  } finally {
    IN_TX.delete(db);
  }
}
