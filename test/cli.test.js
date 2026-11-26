// Covers: src/cli.js `backup` — consistent copy via VACUUM INTO, 0600 file, refuses to overwrite, usage errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { migrate } from '../src/db/migrations.js';
import { createKeyRing } from '../src/secrets.js';
import { createRepoStore } from '../src/repoStore.js';
import { runCli } from '../src/cli.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const DB_FILE = path.join(cwd, 'data', 'cloud-agent.db');
{
  const db = openDb(DB_FILE);
  migrate(db);
  const store = createRepoStore({ db, keyRing: createKeyRing(crypto.randomBytes(32)) });
  store.insertRepo({ id: 'web', url: 'https://github.com/o/r.git', kind: 'https', defaultBranch: 'main', sshKeyPath: null });
  store.setToken('web', 'ghp_cli_token_123456');
  closeDb(db);
}

function run(argv, env = { DB_FILE }) {
  const out = [];
  const err = [];
  const code = runCli(argv, { env, cwd, out: (m) => out.push(m), err: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('backup writes a 0600 copy with the repos and secrets; refuses an existing target', () => {
  const r = run(['backup', 'backups/one.db']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Keep MASTER_KEY separate/);
  const dest = path.join(cwd, 'backups', 'one.db');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(dest)).mode & 0o777, 0o700);
  }
  const copy = openDb(dest);
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM repos').get().n, 1);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM repo_secrets').get().n, 1);
  } finally { closeDb(copy); }

  const again = run(['backup', 'backups/one.db']);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
});

test('backup into a nested missing directory creates it 0700', () => {
  const r = run(['backup', 'a/b/c/two.db']);
  assert.equal(r.code, 0, r.err);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(cwd, 'a', 'b', 'c')).mode & 0o777, 0o700);
});

test('missing database -> 1; bad usage -> 2', () => {
  const r = run(['backup', 'x.db'], { DB_FILE: path.join(cwd, 'nope.db') });
  assert.equal(r.code, 1);
  assert.match(r.err, /database not found/);
  assert.equal(fs.existsSync(path.join(cwd, 'nope.db')), false);
  for (const argv of [[], ['restore', 'x'], ['backup']]) {
    const u = run(argv);
    assert.equal(u.code, 2);
    assert.match(u.err, /usage/);
  }
});
