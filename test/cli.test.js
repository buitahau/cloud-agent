// Covers: src/cli.js `backup` — consistent copy via VACUUM INTO, 0600 file, refuses to overwrite, usage errors —
// and `import` — repos.json + its token vars into an empty database only, atomic, never prints tokens.
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
import { loadConfig } from '../src/config.js';

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

function run(argv, env = { DB_FILE }, dir = cwd) {
  const out = [];
  const err = [];
  const code = runCli(argv, { env, cwd: dir, out: (m) => out.push(m), err: (m) => err.push(m) });
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
  for (const argv of [[], ['restore', 'x'], ['backup'], ['import'], ['import', 'a', 'b']]) {
    const u = run(argv);
    assert.equal(u.code, 2);
    assert.match(u.err, /usage/);
    assert.match(u.err, /import <file>/);
  }
});

// ---- import ----

const MK = crypto.randomBytes(32).toString('base64');
function importEnv(dir, extra = {}) {
  return { API_KEY: 'k', MASTER_KEY: MK, ALLOW_LOCAL_REPOS: 'true', DB_FILE: path.join(dir, 'data', 'x.db'), ...extra };
}
function importDir(doc) {
  const dir = fs.mkdtempSync(path.join(cwd, 'imp-'));
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(doc));
  return dir;
}
const TWO = { repos: [{ id: 'web', url: 'https://github.com/o/web.git', auth: { tokenEnv: 'MY_PAT' } }, { id: 'loc', url: '/srv/loc.git' }] };
const repoCount = (file) => {
  const db = openDb(file);
  try { return db.prepare('SELECT COUNT(*) AS n FROM repos').get().n; } finally { closeDb(db); }
};

test('import fills an empty database from a repos.json + the token vars it names; REPOS_FILE/GIT_TOKEN_* tolerated; refuses a non-empty DB', () => {
  const dir = importDir(TWO);
  const env = importEnv(dir, { MY_PAT: 'ghp_cli_import_123456', GIT_TOKEN_X: 'left', REPOS_FILE: './old.json' });
  const r = run(['import', 'repos.json'], env, dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Imported 2 repos \(web, loc\) from .*repos\.json into .*x\.db/);
  assert.match(r.out, /restart the service/);
  assert.ok(!r.out.includes('ghp_cli_import_123456') && !r.err.includes('ghp_cli_import_123456'));

  const db = openDb(env.DB_FILE);
  try {
    const store = createRepoStore({ db, keyRing: loadConfig({ API_KEY: 'k', MASTER_KEY: MK }, { cwd: dir }).keyRing });
    assert.equal(store.getToken('web'), 'ghp_cli_import_123456');
    const audits = db.prepare('SELECT * FROM audit_log').all();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'import');
    assert.equal(audits[0].actor, 'cli');
  } finally { closeDb(db); }

  const again = run(['import', 'repos.json'], env, dir);
  assert.equal(again.code, 1);
  assert.match(again.err, /already has 2 repos/);
});

test('import failures exit 1 and write nothing', () => {
  const dir = importDir(TWO);
  const env = importEnv(dir);
  const r = run(['import', 'repos.json'], env, dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /Import of repos\.json failed \(nothing was imported\)/);
  assert.match(r.err, /MY_PAT \(auth\.tokenEnv\) is not set/);
  assert.equal(repoCount(env.DB_FILE), 0);

  const missing = run(['import', 'nope.json'], env, dir);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /nope\.json not found/);
  const fresh = path.join(dir, 'fresh', 'x.db');
  assert.equal(run(['import', 'nope.json'], { ...env, DB_FILE: fresh }, dir).code, 1);
  assert.equal(fs.existsSync(fresh), false, 'a missing repos file must not create the database');

  const { MASTER_KEY, ...noKey } = env;
  const nk = run(['import', 'repos.json'], noKey, dir);
  assert.equal(nk.code, 1);
  assert.match(nk.err, /MASTER_KEY is required/);
});
