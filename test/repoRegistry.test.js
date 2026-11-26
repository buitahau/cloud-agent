// Covers: repoRegistry builds one GitSync per stored repo, reads tokens lazily from the store (never holds
// them), and passes the secret env names through; the admin mutations (create/update/setEnabled/setToken/
// remove) with their rules, atomicity, audit rows and log lines, and the status() auth fields.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepoRegistry, RepoMutationError } from '../src/repoRegistry.js';
import { createJobStore } from '../src/jobStore.js';
import { openDb, closeDb } from '../src/db.js';
import { migrate } from '../src/db/migrations.js';
import { createKeyRing } from '../src/secrets.js';
import { createRepoStore } from '../src/repoStore.js';

const ROOT = '/tmp/cloud-agent-registry-test';
const REC = { id: 'a', url: 'https://h/o/r.git', kind: 'https', defaultBranch: 'main', sshKeyPath: null, enabled: true, createdAt: 'x', updatedAt: 'x' };

function stubFactory() {
  const seen = [];
  const factory = (o) => { seen.push(o); return { sync: async () => ({ commit: 'abc' }) }; };
  return { seen, factory };
}

test('createRepoRegistry: one GitSync per record, lazy getToken, secretEnvNames forwarded (default [])', () => {
  const tokens = { a: 't' };
  const store = { list: () => [REC], getToken: (id) => tokens[id] };
  const a = stubFactory();
  const reg = createRepoRegistry({ repoStore: store, workspaceRoot: ROOT, gitTimeoutMs: 1000, secretEnvNames: ['MY_PAT'], gitSyncFactory: a.factory });
  assert.equal(a.seen.length, 1);
  assert.deepEqual(a.seen[0].secretEnvNames, ['MY_PAT']);
  assert.equal(a.seen[0].token, undefined);
  assert.equal(a.seen[0].workspaceDir, path.join(ROOT, 'a'));
  assert.equal(a.seen[0].timeoutMs, 1000);
  assert.equal(a.seen[0].getToken(), 't');
  tokens.a = 't2';
  assert.equal(a.seen[0].getToken(), 't2');

  assert.equal(reg.get('a').workspaceDir, path.join(ROOT, 'a'));
  assert.equal(reg.get('a').config.workspaceDir, path.join(ROOT, 'a'));
  assert.deepEqual(reg.ids(), ['a']);
  assert.equal(reg.has('a'), true);
  const item = reg.list()[0];
  assert.equal('token' in item, false);
  assert.equal('tokenEnv' in item, false);
  assert.equal(item.kind, 'https');
  assert.equal(item.enabled, true);
  assert.ok(!JSON.stringify(reg.list()).includes('t2'));

  const b = stubFactory();
  createRepoRegistry({ repoStore: store, workspaceRoot: ROOT, gitTimeoutMs: 1000, gitSyncFactory: b.factory });
  assert.deepEqual(b.seen[0].secretEnvNames, []);
});

test('createRepoRegistry with a real store: a token set after construction is picked up', () => {
  const db = openDb(':memory:');
  after(() => closeDb(db));
  migrate(db);
  const store = createRepoStore({ db, keyRing: createKeyRing(crypto.randomBytes(32)) });
  store.insertRepo({ id: 'a', url: 'https://h/o/r.git', kind: 'https', defaultBranch: 'main', sshKeyPath: null });
  const s = stubFactory();
  createRepoRegistry({ repoStore: store, workspaceRoot: ROOT, gitTimeoutMs: 1000, gitSyncFactory: s.factory });
  assert.equal(s.seen[0].getToken(), null);
  store.setToken('a', 'tok-2-abcdef');
  assert.equal(s.seen[0].getToken(), 'tok-2-abcdef');
});

// ---- mutations ----

const CTX = { actor: 'ops', ip: '10.0.0.1' };
const TOK = 'ghp_registry_abcdef';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const keyFile = path.join(tmp, 'id_x');
fs.writeFileSync(keyFile, 'key');
const NO_WORKER = { stats: () => ({ running: [] }), queueLength: () => 0 };

function fixture({ allowLocal = true } = {}) {
  const db = openDb(':memory:');
  after(() => closeDb(db));
  migrate(db);
  const store = createRepoStore({ db, keyRing: createKeyRing(crypto.randomBytes(32)) });
  const jobs = createJobStore();
  const workspaceRoot = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const s = stubFactory();
  const lines = { info: [], error: [] };
  const log = { info: (m) => lines.info.push(m), error: (m) => lines.error.push(m) };
  const reg = createRepoRegistry({
    repoStore: store, jobs, workspaceRoot, gitTimeoutMs: 1000, gitSyncFactory: s.factory, allowLocal, sshKeysDir: tmp, log,
  });
  const audits = () => db.prepare('SELECT * FROM audit_log ORDER BY id').all().map((r) => ({ ...r, details: JSON.parse(r.details) }));
  const secretCount = () => db.prepare('SELECT COUNT(*) AS n FROM repo_secrets').get().n;
  return { db, store, jobs, workspaceRoot, seen: s.seen, lines, reg, audits, secretCount };
}

/** @returns {RepoMutationError} */
function mutErr(fn, status, re) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RepoMutationError, `expected RepoMutationError, got ${e}`);
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail('expected a RepoMutationError');
}

const WEB = { id: 'web', url: 'https://github.com/o/r.git' };

test('create: https needs a token; token stored encrypted, audited and logged without its value', () => {
  const f = fixture();
  mutErr(() => f.reg.create(WEB, CTX), 400, /need a token/);
  assert.equal(f.reg.has('web'), false);
  const n = f.seen.length;
  const cfg = f.reg.create({ ...WEB, token: TOK }, CTX);
  assert.equal(cfg.id, 'web');
  assert.equal(cfg.kind, 'https');
  assert.equal(f.reg.has('web'), true);
  assert.equal(f.seen.length, n + 1);
  assert.equal(f.seen.at(-1).getToken(), TOK);
  const [a] = f.audits();
  assert.equal(a.action, 'repo.create');
  assert.equal(a.actor, 'ops');
  assert.equal(a.ip, '10.0.0.1');
  assert.equal(a.repo_id, 'web');
  assert.equal(a.details.token, 'set …cdef');
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all()).includes(TOK));
  assert.ok(!f.lines.info.join('\n').includes(TOK));
  assert.ok(f.lines.info.some((l) => /^\[audit\] ops \(10\.0\.0\.1\) repo\.create web /.test(l)), f.lines.info.join('\n'));
});

test('create errors: duplicate, bad id, local disabled, token on local, unknown field, key outside SSH_KEYS_DIR', () => {
  const f = fixture();
  f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX);
  mutErr(() => f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX), 409, /already exists/);
  const e = mutErr(() => f.reg.create({ id: 'Bad!', url: '/x/a.git' }, CTX), 400);
  assert.ok(Array.isArray(e.problems));
  mutErr(() => fixture({ allowLocal: false }).reg.create({ id: 'l2', url: '/x/a.git' }, CTX), 400, /ALLOW_LOCAL_REPOS/);
  mutErr(() => f.reg.create({ id: 'l3', url: '/x/a.git', token: TOK }, CTX), 400, /only applies to https/);
  mutErr(() => f.reg.create({ id: 'l4', url: '/x/a.git', enabled: true }, CTX), 400, /unknown field: enabled/);
  mutErr(() => f.reg.create({ id: 's1', url: 'git@github.com:o/r.git', sshKeyPath: '/etc/passwd' }, CTX), 400, /SSH_KEYS_DIR/);
  mutErr(() => f.reg.create([], CTX), 400, /JSON object/);
  assert.equal(f.audits().length, 1);
});

test('create is atomic: an audit failure rolls back the repo and its token', () => {
  const f = fixture();
  f.store.insertAudit = () => { throw new Error('boom'); };
  assert.throws(() => f.reg.create({ id: 'x', url: 'https://github.com/o/x.git', token: TOK }, CTX), /boom/);
  assert.equal(f.store.get('x'), null);
  assert.equal(f.reg.has('x'), false);
  assert.equal(f.secretCount(), 0);
});

test('update defaultBranch: entry swapped, old snapshot untouched, audited diff; identical patch is a no-op', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  const old = f.reg.get('web');
  const cfg = f.reg.update('web', { defaultBranch: 'dev' }, CTX);
  assert.equal(old.config.defaultBranch, 'main');
  assert.notEqual(f.reg.get('web'), old);
  assert.equal(cfg.defaultBranch, 'dev');
  assert.equal(f.reg.get('web').config.defaultBranch, 'dev');
  assert.deepEqual(f.audits().at(-1).details, { defaultBranch: { from: 'main', to: 'dev' } });
  assert.equal(f.store.getToken('web'), TOK);
  const n = f.audits().length;
  f.reg.update('web', { defaultBranch: 'dev' }, CTX);
  assert.equal(f.audits().length, n);
  mutErr(() => f.reg.update('web', {}, CTX), 400, /nothing to update/);
  mutErr(() => f.reg.update('web', { id: 'x' }, CTX), 400, /unknown field/);
  mutErr(() => f.reg.update('nope', { defaultBranch: 'x' }, CTX), 404);
});

test('update url: same remote keeps the workspace; a different remote wipes it', () => {
  const f = fixture();
  f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX);
  const ws = path.join(f.workspaceRoot, 'loc');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'marker'), 'x');
  f.reg.update('loc', { url: '/x/a' }, CTX);
  assert.ok(fs.existsSync(path.join(ws, 'marker')));
  assert.equal(f.audits().at(-1).details.workspace, undefined);
  assert.deepEqual(f.audits().at(-1).details.url, { from: '/x/a.git', to: '/x/a' });
  f.reg.update('loc', { url: '/x/b.git' }, CTX);
  assert.equal(fs.existsSync(ws), false);
  assert.equal(f.audits().at(-1).details.workspace, 'wiped');
  assert.equal(f.reg.get('loc').config.url, '/x/b.git');
});

test('update url to another host needs a token in the same patch; same host keeps the token', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  const n = f.audits().length;
  mutErr(() => f.reg.update('web', { url: 'https://gitlab.com/o/r.git' }, CTX), 400, /token is required/);
  assert.equal(f.store.get('web').url, WEB.url);
  assert.notEqual(f.store.tokenInfo('web'), null);
  assert.equal(f.audits().length, n);

  f.reg.update('web', { url: 'https://gitlab.com/o/r.git', token: 'ghp_newhost_9999' }, CTX);
  assert.equal(f.store.getToken('web'), 'ghp_newhost_9999');
  const d = f.audits().at(-1).details;
  assert.equal(d.token, 'set …9999');
  assert.deepEqual(d.url, { from: WEB.url, to: 'https://gitlab.com/o/r.git' });

  f.reg.update('web', { url: 'https://gitlab.com/o/r2.git' }, CTX);
  assert.equal(f.store.getToken('web'), 'ghp_newhost_9999');
  assert.equal(f.audits().at(-1).details.token, undefined);
});

test('update https -> ssh: needs sshKeyPath, drops the token, token in that patch rejected', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  mutErr(() => f.reg.update('web', { url: 'git@github.com:o/r.git' }, CTX), 400, /sshKeyPath/);
  mutErr(() => f.reg.update('web', { url: 'git@github.com:o/r.git', sshKeyPath: keyFile, token: TOK }, CTX), 400, /only applies to https/);
  f.reg.update('web', { url: 'git@github.com:o/r.git', sshKeyPath: keyFile }, CTX);
  assert.equal(f.store.tokenInfo('web'), null);
  assert.equal(f.audits().at(-1).details.token, 'dropped');
  assert.deepEqual(f.reg.status('web', f.jobs, NO_WORKER).auth, { kind: 'ssh', token: null, ssh_key_path: keyFile });
  // ssh -> local clears sshKeyPath automatically
  f.reg.update('web', { url: '/x/c.git' }, CTX);
  assert.equal(f.reg.get('web').config.sshKeyPath, null);
  assert.deepEqual(f.audits().at(-1).details.sshKeyPath, { from: keyFile, to: null });
});

test('update url vs jobs: queued job allows it, a pulling job blocks it (409) but not a branch change', () => {
  const f = fixture();
  f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX);
  f.jobs.create({ prompt: 'p', branch: 'main', repoId: 'loc' });
  f.reg.update('loc', { url: '/x/b.git' }, CTX);
  const j2 = f.jobs.create({ prompt: 'p', branch: 'main', repoId: 'loc' });
  f.jobs.transition(j2.id, 'pulling');
  mutErr(() => f.reg.update('loc', { url: '/x/c.git' }, CTX), 409, /running job/);
  f.reg.update('loc', { defaultBranch: 'dev' }, CTX);
  assert.equal(f.reg.get('loc').config.defaultBranch, 'dev');
  assert.equal(f.reg.get('loc').config.url, '/x/b.git');
});

test('setEnabled: disable/enable audited, repeat is a no-op, non-boolean rejected', () => {
  const f = fixture();
  f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX);
  f.reg.setEnabled('loc', false, CTX);
  assert.equal(f.reg.get('loc').config.enabled, false);
  assert.equal(f.store.get('loc').enabled, false);
  let a = f.audits().at(-1);
  assert.equal(a.action, 'repo.disable');
  assert.deepEqual(a.details, { enabled: { from: true, to: false } });
  const n = f.audits().length;
  f.reg.setEnabled('loc', false, CTX);
  assert.equal(f.audits().length, n);
  f.reg.update('loc', { enabled: true }, CTX);
  a = f.audits().at(-1);
  assert.equal(a.action, 'repo.enable');
  assert.equal(f.reg.get('loc').config.enabled, true);
  mutErr(() => f.reg.update('loc', { enabled: 'no' }, CTX), 400, /enabled/);
  mutErr(() => f.reg.setEnabled('loc', 'no', CTX), 400, /enabled/);
});

test('setToken: unknown 404, local 400, invalid 400 without the value; OK replaces and audits', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  f.reg.create({ id: 'loc', url: '/x/a.git' }, CTX);
  mutErr(() => f.reg.setToken('nope', TOK, CTX), 404);
  mutErr(() => f.reg.setToken('loc', TOK, CTX), 400);
  const e = mutErr(() => f.reg.setToken('web', 'bad token', CTX), 400);
  assert.ok(!e.message.includes('bad token'));
  f.reg.setToken('web', 'ghp_replaced_wxyz', CTX);
  assert.equal(f.store.getToken('web'), 'ghp_replaced_wxyz');
  const a = f.audits().at(-1);
  assert.equal(a.action, 'token.set');
  assert.deepEqual(a.details, { token: 'set …wxyz' });
  assert.ok(!f.lines.info.join('\n').includes('ghp_replaced_wxyz'));
});

test('remove: 409 with a queued job; afterwards removes row, secrets and workspace; history kept; then 404', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  const ws = path.join(f.workspaceRoot, 'web');
  fs.mkdirSync(ws, { recursive: true });
  const j = f.jobs.create({ prompt: 'p', branch: 'main', repoId: 'web' });
  mutErr(() => f.reg.remove('web', CTX), 409, /disable it and wait/);
  assert.equal(f.reg.has('web'), true);
  f.jobs.transition(j.id, 'failed', { error: 'x' });
  f.reg.remove('web', CTX);
  assert.equal(f.reg.has('web'), false);
  assert.equal(f.store.get('web'), null);
  assert.equal(f.secretCount(), 0);
  assert.equal(fs.existsSync(ws), false);
  const a = f.audits().at(-1);
  assert.equal(a.action, 'repo.delete');
  assert.equal(a.repo_id, 'web');
  assert.ok(f.jobs.get(j.id));
  mutErr(() => f.reg.remove('web', CTX), 404);
});

test('status(): enabled and auth fields; never the token', () => {
  const f = fixture();
  f.reg.create({ ...WEB, token: TOK }, CTX);
  const st = f.reg.status('web', f.jobs, NO_WORKER);
  assert.equal(st.enabled, true);
  assert.equal(st.auth.kind, 'https');
  assert.equal(st.auth.ssh_key_path, null);
  assert.equal(st.auth.token.set, true);
  assert.equal(st.auth.token.hint, 'cdef');
  assert.ok(!Number.isNaN(Date.parse(st.auth.token.updated_at)));
  assert.ok(!JSON.stringify(st).includes(TOK));
  assert.deepEqual(f.reg.listAudit({ limit: 1 }).entries.map((e) => e.action), ['repo.create']);
});
