// Covers: src/repoImport.js — importReposFile (empty database only, atomic) and loadReposFile validation
// (ported from the old config.js tests).
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
import { importReposFile, loadReposFile, ImportError, META_IMPORTED } from '../src/repoImport.js';

const K1 = crypto.randomBytes(32);
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const sshKey = path.join(cwd, 'id_test');
fs.writeFileSync(sshKey, 'key');

const dbs = [];
after(() => dbs.forEach((db) => closeDb(db)));

let fileNo = 0;
/** Write a repos file into cwd and return its absolute path. */
function writeRepos(doc) {
  const file = path.join(cwd, `repos-${++fileNo}.json`);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

function setup(file) {
  const db = openDb(':memory:');
  dbs.push(db);
  migrate(db);
  const store = createRepoStore({ db, keyRing: createKeyRing(K1) });
  const config = { workspaceRoot: path.join(cwd, 'workspaces'), allowLocalRepos: true, sshKeysDir: cwd };
  const warn = [];
  const log = { warn: (m) => warn.push(m) };
  return { db, store, config, file, warn, log };
}
const counts = (db) => ({
  repos: db.prepare('SELECT COUNT(*) AS n FROM repos').get().n,
  secrets: db.prepare('SELECT COUNT(*) AS n FROM repo_secrets').get().n,
  audit: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
});

const WEB_TOKEN = 'ghp_web_1234567890';
const THREE = {
  repos: [
    { id: 'web', url: 'https://github.com/o/web.git', defaultBranch: 'dev', auth: { tokenEnv: 'GIT_TOKEN_WEB' } },
    { id: 'api', url: 'git@github.com:o/api.git', auth: { sshKeyPath: sshKey } },
    { id: 'loc', url: '/srv/loc.git' },
  ],
};

test('imports https + ssh + local repos with encrypted token, meta flag and one audit row; refuses a non-empty DB', () => {
  const t = setup(writeRepos(THREE));
  const r = importReposFile({ ...t, env: { GIT_TOKEN_WEB: WEB_TOKEN }, cwd });
  assert.deepEqual(r, { count: 3, ids: ['web', 'api', 'loc'] });
  assert.deepEqual(t.store.list().map((x) => [x.id, x.kind, x.defaultBranch]), [['web', 'https', 'dev'], ['api', 'ssh', 'main'], ['loc', 'local', 'main']]);
  assert.equal(t.store.get('api').sshKeyPath, sshKey);
  assert.equal(t.store.getToken('web'), WEB_TOKEN);
  assert.equal(t.store.getToken('api'), null);
  assert.ok(!Number.isNaN(Date.parse(t.store.getMeta(META_IMPORTED))));
  const audits = t.db.prepare('SELECT * FROM audit_log').all();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'import');
  assert.equal(audits[0].actor, 'cli');
  assert.ok(audits[0].details.includes('set …7890'));
  assert.ok(!audits[0].details.includes(WEB_TOKEN));
  for (const row of t.db.prepare('SELECT ciphertext FROM repo_secrets').all()) assert.ok(!Buffer.from(row.ciphertext).includes(WEB_TOKEN));
  assert.deepEqual(t.warn, []);

  // 2. second call: refused (database not empty), nothing changes
  const before = counts(t.db);
  assert.throws(() => importReposFile({ ...t, env: { GIT_TOKEN_WEB: WEB_TOKEN }, cwd }),
    (e) => e instanceof ImportError && /already has 3 repos; import only fills an empty database/.test(e.message));
  assert.deepEqual(counts(t.db), before);

  // 3. emptied table: the explicit command is not gated by the meta flag, so it imports again
  t.db.exec('DELETE FROM repos');
  assert.deepEqual(importReposFile({ ...t, env: { GIT_TOKEN_WEB: WEB_TOKEN }, cwd }), { count: 3, ids: ['web', 'api', 'loc'] });
  assert.notEqual(t.store.getMeta(META_IMPORTED), null);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 2);
});

test('atomic: an invalid repo imports nothing', () => {
  const t = setup(writeRepos({ repos: [
    { id: 'ok', url: '/srv/ok.git' },
    { id: 'web', url: 'https://github.com/o/web.git', auth: { tokenEnv: 'GIT_TOKEN_NOPE' } },
  ] }));
  assert.throws(() => importReposFile({ ...t, env: {}, cwd }), (err) => err instanceof ImportError
    && err.problems.some((p) => /GIT_TOKEN_NOPE \(auth.tokenEnv\) is not set/.test(p))
    && /Import of repos\.json failed \(nothing was imported\)/.test(err.message));
  assert.deepEqual(counts(t.db), { repos: 0, secrets: 0, audit: 0 });
  assert.equal(t.store.getMeta(META_IMPORTED), null);
});

test('atomic: a failing write rolls back the whole import', () => {
  const t = setup(writeRepos({ repos: [
    { id: 'a', url: 'https://github.com/o/a.git', auth: { tokenEnv: 'GIT_TOKEN_A' } },
    { id: 'b', url: 'https://github.com/o/b.git', auth: { tokenEnv: 'GIT_TOKEN_B' } },
  ] }));
  const orig = t.store.setToken;
  let calls = 0;
  t.store.setToken = (id, tok) => {
    if (++calls === 2) throw new Error('disk on fire');
    return orig(id, tok);
  };
  assert.throws(() => importReposFile({ ...t, env: { GIT_TOKEN_A: 'tok-a-123456', GIT_TOKEN_B: 'tok-b-123456' }, cwd }), /disk on fire/);
  assert.deepEqual(counts(t.db), { repos: 0, secrets: 0, audit: 0 });
  assert.equal(t.store.getMeta(META_IMPORTED), null);
});

test('non-empty database: refused, nothing changes', () => {
  const t = setup(writeRepos(THREE));
  t.store.insertRepo({ id: 'x', url: '/x.git', kind: 'local', defaultBranch: 'main', sshKeyPath: null });
  assert.throws(() => importReposFile({ ...t, env: { GIT_TOKEN_WEB: WEB_TOKEN }, cwd }), (e) => e instanceof ImportError && /already has 1 repo;/.test(e.message));
  assert.deepEqual(t.store.list().map((r) => r.id), ['x']);
});

test('missing file / directory -> not found; bad JSON / shape -> ImportError; empty list is a valid import', () => {
  const missing = path.join(cwd, 'nope.json');
  const t = setup(missing);
  assert.throws(() => importReposFile({ ...t, env: {}, cwd }), (e) => e instanceof ImportError && e.problems[0] === `${missing} not found`);
  assert.equal(t.store.getMeta(META_IMPORTED), null);

  const dir = path.join(cwd, 'dir.json');
  fs.mkdirSync(dir);
  assert.throws(() => importReposFile({ ...setup(dir), env: {}, cwd }), /not found/);

  assert.throws(() => importReposFile({ ...setup(writeRepos('{ nope')), env: {}, cwd }), (e) => e instanceof ImportError && /not valid JSON/.test(e.problems[0]));
  assert.throws(() => importReposFile({ ...setup(writeRepos('[]')), env: {}, cwd }), (e) => e instanceof ImportError && /JSON object/.test(e.problems[0]));
  assert.throws(() => importReposFile({ ...setup(writeRepos({ repos: {} })), env: {}, cwd }), (e) => /"repos" must be an array/.test(e.problems[0]));

  const e = setup(writeRepos({ repos: [] }));
  assert.deepEqual(importReposFile({ ...e, env: {}, cwd }), { count: 0, ids: [] });
  assert.notEqual(e.store.getMeta(META_IMPORTED), null);
});

test('repos.json workspaceRoot is ignored with a warning when it differs from WORKSPACE_ROOT', () => {
  const a = setup(writeRepos({ workspaceRoot: './old', repos: [] }));
  importReposFile({ ...a, env: {}, cwd });
  assert.equal(a.warn.length, 1);
  assert.match(a.warn[0], /workspaceRoot .* is ignored; .*WORKSPACE_ROOT=/);
  assert.ok(a.warn[0].includes(path.join(cwd, 'old')));
  const b = setup(writeRepos({ workspaceRoot: './workspaces', repos: [] }));
  importReposFile({ ...b, env: {}, cwd });
  assert.deepEqual(b.warn, []);
});

// ---- loadReposFile (ported from the old config.js tests) ----

const OPTS = { cwd, allowLocal: true, sshKeysDir: null };

test('loadReposFile: multiple repos, each with its own credential; tokens read from the named env vars', () => {
  const f = loadReposFile(writeRepos({
    workspaceRoot: './ws',
    repos: [
      { id: 'web', url: 'https://github.com/org/web.git', defaultBranch: 'dev', auth: { tokenEnv: 'GIT_TOKEN_WEB' } },
      { id: 'api', url: 'git@github.com:org/api.git', auth: { sshKeyPath: sshKey } },
      { id: 'tools', url: 'ssh://git@github.com/org/tools.git', auth: { sshKeyPath: sshKey } },
    ],
  }), { GIT_TOKEN_WEB: ' ghp_web ' }, OPTS);
  assert.deepEqual(f.problems, []);
  assert.equal(f.found, true);
  assert.equal(f.workspaceRoot, path.join(cwd, 'ws'));
  assert.deepEqual(f.repos.map((r) => [r.id, r.kind, r.defaultBranch]), [['web', 'https', 'dev'], ['api', 'ssh', 'main'], ['tools', 'ssh', 'main']]);
  assert.equal(f.repos[0].token, 'ghp_web');
  assert.equal(f.repos[0].tokenEnv, 'GIT_TOKEN_WEB');
  assert.equal(f.repos[1].sshKeyPath, sshKey);
  assert.equal(f.repos[1].token, null);
  assert.deepEqual(f.tokenEnvNames, ['GIT_TOKEN_WEB']);
});

test('loadReposFile: every remote repo must have its own credential; no global fallback', () => {
  const { problems } = loadReposFile(writeRepos({ repos: [
    { id: 'web', url: 'https://github.com/org/web.git' },
    { id: 'api', url: 'git@github.com:org/api.git' },
    { id: 'mixed', url: 'https://github.com/org/m.git', auth: { tokenEnv: 'T_M', sshKeyPath: sshKey } },
    { id: 'loc', url: '/srv/x.git', auth: { tokenEnv: 'T_M' } },
  ] }), { T_M: 'x' }, OPTS);
  assert.ok(problems.some((p) => p.includes('"web"') && p.includes('set auth.tokenEnv')));
  assert.ok(problems.some((p) => p.includes('"api"') && p.includes('set auth.sshKeyPath')));
  assert.ok(problems.some((p) => p.includes('"mixed"') && p.includes('sshKeyPath only applies to ssh')));
  assert.ok(problems.some((p) => p.includes('"loc"') && p.includes('local repos take no auth')));
});

test('loadReposFile: bad ids, duplicates, bad urls, bad branch, missing token env var, missing key -> all listed', () => {
  const { problems, repos } = loadReposFile(writeRepos({ repos: [
    { id: 'Bad_Id', url: '/a.git' },
    { id: 'admin', url: '/a.git' },
    { id: 'dup', url: '/a.git' },
    { id: 'dup', url: '/b.git' },
    { id: 'rce', url: 'ext::sh' },
    { id: 'creds', url: 'https://user:pass@github.com/o/r.git', auth: { tokenEnv: 'X' } },
    { id: 'plain', url: 'http://github.com/o/r.git' },
    { id: 'branch', url: '/a.git', defaultBranch: '--upload-pack=x' },
    { id: 'notoken', url: 'https://github.com/o/r.git', auth: { tokenEnv: 'NOT_SET_ANYWHERE' } },
    { id: 'nokey', url: 'git@github.com:o/r.git', auth: { sshKeyPath: '~/definitely-missing-key-xyz' } },
    { id: 'badauth', url: '/a.git', auth: 'x' },
  ] }), { X: 'x' }, OPTS);
  const has = (id, re) => assert.ok(problems.some((p) => p.includes(id) && re.test(p)), `${id} ${re}: ${problems.join(' | ')}`);
  has('Bad_Id', /id must be/);
  has('"admin"', /id must be/);
  has('"dup"', /duplicate id/);
  has('"rce"', /remote-helper/);
  has('"creds"', /must not embed credentials/);
  has('"plain"', /http:\/\/ is not allowed/);
  has('"branch"', /defaultBranch/);
  has('"notoken"', /NOT_SET_ANYWHERE \(auth.tokenEnv\) is not set/);
  has('"nokey"', new RegExp(path.join(os.homedir(), 'definitely-missing-key-xyz').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  has('"badauth"', /auth must be an object/);
  assert.deepEqual(repos.map((r) => r.id), ['dup']);
});

test('loadReposFile: ALLOW_LOCAL_REPOS, SSH_KEYS_DIR, token format; problems never contain token values', () => {
  const local = loadReposFile(writeRepos({ repos: [{ id: 'loc', url: '/srv/x.git' }] }), {}, { ...OPTS, allowLocal: false });
  assert.match(local.problems[0], /ALLOW_LOCAL_REPOS/);
  const outside = loadReposFile(writeRepos({ repos: [{ id: 'api', url: 'git@h:o/r', auth: { sshKeyPath: sshKey } }] }), {}, { ...OPTS, sshKeysDir: path.join(cwd, 'keys') });
  assert.match(outside.problems[0], /auth\.sshKeyPath must be inside SSH_KEYS_DIR/);
  const env = { T_BAD: 'ghp_bad value', T_LONG: 'y'.repeat(1001) };
  const tok = loadReposFile(writeRepos({ repos: [
    { id: 'a', url: 'https://github.com/o/a.git', auth: { tokenEnv: 'T_BAD' } },
    { id: 'b', url: 'https://github.com/o/b.git', auth: { tokenEnv: 'T_LONG' } },
  ] }), env, OPTS);
  assert.ok(tok.problems.some((p) => /"a": environment variable T_BAD \(auth.tokenEnv\) token must not contain whitespace/.test(p)), tok.problems.join(' | '));
  assert.ok(tok.problems.some((p) => /"b": .*T_LONG.*1-1000 characters/.test(p)));
  const json = JSON.stringify(tok.problems);
  assert.ok(!json.includes('ghp_bad'));
  assert.ok(!json.includes('yyyy'));
});

test('loadReposFile: GIT_TOKEN may be used as a tokenEnv', () => {
  const f = loadReposFile(writeRepos({ repos: [{ id: 'web', url: 'https://github.com/o/r.git', auth: { tokenEnv: 'GIT_TOKEN' } }] }), { GIT_TOKEN: 'ghp_1' }, OPTS);
  assert.deepEqual(f.problems, []);
  assert.equal(f.repos[0].token, 'ghp_1');
});
