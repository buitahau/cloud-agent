// Covers: src/db.js (open, file modes, pragmas, tx) and src/db/migrations.js (0 -> N, idempotent, newer refused,
// per-step rollback, schema constraints).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb, tx } from '../src/db.js';
import { MIGRATIONS, SCHEMA_VERSION, MigrationError, getSchemaVersion, migrate } from '../src/db/migrations.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
const mode = (f) => fs.statSync(f).mode & 0o777;
const win = process.platform === 'win32';
const count = (db, table = 't') => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('openDb creates parent dir 0700, file 0600, -wal 0600 while open', { skip: win }, () => {
  const dir = tmp();
  const file = path.join(dir, 'data', 'x.db');
  const db = openDb(file);
  try {
    db.exec('CREATE TABLE t(x)');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.equal(mode(file), 0o600);
    assert.ok(fs.existsSync(`${file}-wal`));
    assert.equal(mode(`${file}-wal`), 0o600);
  } finally {
    closeDb(db);
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb sets pragmas', () => {
  const dir = tmp();
  const db = openDb(path.join(dir, 'x.db'));
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb tightens an existing 0644 file to 0600', { skip: win }, () => {
  const dir = tmp();
  const file = path.join(dir, 'x.db');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o644);
  const db = openDb(file);
  try {
    assert.equal(mode(file), 0o600);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tx commits and returns the callback value', () => {
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE t(x)');
    const out = tx(db, () => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      return 42;
    });
    assert.equal(out, 42);
    assert.equal(count(db), 1);
  } finally { closeDb(db); }
});

test('tx rolls back on throw and rethrows the same error', () => {
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE t(x)');
    const boom = new Error('boom');
    assert.throws(() => tx(db, () => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      throw boom;
    }), (err) => err === boom);
    assert.equal(count(db), 0);
    tx(db, () => db.prepare('INSERT INTO t VALUES (?)').run(2));
    assert.equal(count(db), 1);
  } finally { closeDb(db); }
});

test('nested tx throws and the outer tx is rolled back', () => {
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE t(x)');
    assert.throws(() => tx(db, () => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      tx(db, () => {});
    }), /cannot be nested/);
    assert.equal(count(db), 0);
  } finally { closeDb(db); }
});

test('async tx callback -> TypeError, rolled back', () => {
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE t(x)');
    assert.throws(() => tx(db, async () => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
    }), TypeError);
    assert.equal(count(db), 0);
  } finally { closeDb(db); }
});

test('openDb on an unopenable path throws "cannot open database"', () => {
  const dir = tmp();
  try {
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, '');
    assert.throws(() => openDb(path.join(notADir, 'x.db')), /cannot open database/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate: fresh file -> SCHEMA_VERSION, idempotent, survives reopen', () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  assert.ok(Object.isFrozen(MIGRATIONS));
  assert.ok(SCHEMA_VERSION >= 1);
  const dir = tmp();
  const file = path.join(dir, 'x.db');
  let db = openDb(file);
  try {
    assert.deepEqual(migrate(db), { from: 0, to: SCHEMA_VERSION });
    const names = (type) => db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((r) => r.name);
    for (const t of ['repos', 'repo_secrets', 'audit_log', 'meta']) assert.ok(names('table').includes(t), t);
    for (const i of ['repo_secrets_key_id', 'audit_log_repo']) assert.ok(names('index').includes(i), i);
    assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    closeDb(db);
    db = openDb(file);
    assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate refuses a database newer than the code', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.name, 'MigrationError');
      assert.equal(err.dbVersion, SCHEMA_VERSION + 1);
      assert.equal(err.codeVersion, SCHEMA_VERSION);
      assert.match(err.message, /newer than this code/);
      return true;
    });
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION + 1);
  } finally { closeDb(db); }
});

test('a failing migration step rolls back only itself', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(() => migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(x); NOT SQL']));
    assert.equal(getSchemaVersion(db), 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(tables.includes('a'));
    assert.ok(!tables.includes('b'));
    assert.deepEqual(migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(x)']), { from: 1, to: 2 });
  } finally { closeDb(db); }
});

test('schema constraints', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const now = new Date().toISOString();
    const insRepo = db.prepare('INSERT INTO repos (id, url, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    assert.throws(() => insRepo.run('bad', 'ftp://x', 'ftp', now, now), /CHECK constraint failed/);
    insRepo.run('web', 'https://github.com/o/web.git', 'https', now, now);
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get('web');
    assert.equal(repo.default_branch, 'main');
    assert.equal(repo.enabled, 1);

    const insSecret = db.prepare(
      'INSERT INTO repo_secrets (repo_id, name, key_id, iv, ciphertext, tag, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const iv = Buffer.from([1, 2, 3, 4]);
    assert.throws(() => insSecret.run('missing', 'token', 'k', iv, iv, iv, '', now), /FOREIGN KEY constraint failed/);
    assert.throws(() => insSecret.run('web', 'other', 'k', iv, iv, iv, '', now), /CHECK/);
    insSecret.run('web', 'token', 'k', iv, iv, iv, '', now);
    const row = db.prepare('SELECT * FROM repo_secrets WHERE repo_id = ?').get('web');
    assert.ok(row.iv instanceof Uint8Array);
    assert.ok(Buffer.from(row.iv).equals(iv));
    assert.equal(row.alg, 'A256GCM');

    db.prepare('DELETE FROM repos WHERE id = ?').run('web');
    assert.equal(count(db, 'repo_secrets'), 0);

    const insAudit = db.prepare('INSERT INTO audit_log (at, actor, action) VALUES (?, ?, ?)');
    const a = insAudit.run(now, 'admin', 'repo.create');
    const b = insAudit.run(now, 'admin', 'repo.delete');
    assert.equal(Number(b.lastInsertRowid), Number(a.lastInsertRowid) + 1);
    assert.equal(db.prepare('SELECT details FROM audit_log WHERE id = ?').get(a.lastInsertRowid).details, '{}');

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('k', 'v');
    assert.throws(() => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('k', 'w'), /UNIQUE/);
  } finally { closeDb(db); }
});
