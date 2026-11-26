// Covers: src/repoStore.js — repo rows, encrypted tokens (AAD binding, rotation), meta/audit, and the startup
// helpers verifyAndRotateSecrets / checkStoredRepos / findEnvVarsHoldingTokens. In-memory SQLite.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { migrate } from '../src/db/migrations.js';
import { createKeyRing, deriveKeyId, SecretDecryptError } from '../src/secrets.js';
import { createRepoStore, verifyAndRotateSecrets, checkStoredRepos, findEnvVarsHoldingTokens, SecretCheckError } from '../src/repoStore.js';

const K1 = crypto.randomBytes(32);
const K2 = crypto.randomBytes(32);
const kid = (k) => deriveKeyId(k);
const TOK = 'ghp_store_secret_1234567890';

const dbs = [];
after(() => dbs.forEach((db) => closeDb(db)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sshKey = path.join(tmp, 'id_test');
fs.writeFileSync(sshKey, 'key');

function fresh(ring = createKeyRing(K1), now) {
  const db = openDb(':memory:');
  dbs.push(db);
  migrate(db);
  return { db, store: createRepoStore({ db, keyRing: ring, now }) };
}
const https = (id, url = `https://github.com/o/${id}.git`) => ({ id, url, kind: 'https', defaultBranch: 'main', sshKeyPath: null });
const logger = () => {
  const info = [];
  const warn = [];
  return { info, warn, log: { info: (m) => info.push(m), warn: (m) => warn.push(m) } };
};

test('insertRepo / get / list round trip: camelCase, enabled, ISO timestamps, insertion order; duplicate id throws', () => {
  const { store } = fresh();
  store.tx(() => {
    store.insertRepo(https('zz'));
    store.insertRepo({ id: 'aa', url: 'git@h:o/r', kind: 'ssh', defaultBranch: 'dev', sshKeyPath: sshKey });
  });
  assert.equal(store.count(), 2);
  assert.deepEqual(store.list().map((r) => r.id), ['zz', 'aa']);
  const a = store.get('aa');
  assert.equal(a.kind, 'ssh');
  assert.equal(a.defaultBranch, 'dev');
  assert.equal(a.sshKeyPath, sshKey);
  assert.equal(a.enabled, true);
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.equal(a.createdAt, a.updatedAt);
  assert.equal(store.get('zz').sshKeyPath, null);
  assert.equal(store.get('nope'), null);
  assert.throws(() => store.insertRepo(https('zz')));
});

test('setToken / getToken / tokenInfo; replace gets a new iv; ssh/local/unknown/invalid rejected without the value', () => {
  const { db, store } = fresh();
  store.insertRepo(https('web'));
  store.insertRepo({ id: 'api', url: 'git@h:o/r', kind: 'ssh', defaultBranch: 'main', sshKeyPath: sshKey });
  store.insertRepo({ id: 'loc', url: '/x.git', kind: 'local', defaultBranch: 'main', sshKeyPath: null });
  assert.equal(store.getToken('web'), null);
  assert.equal(store.tokenInfo('web'), null);
  const r = store.setToken('web', TOK);
  assert.equal(r.hint, '7890');
  assert.deepEqual(store.tokenInfo('web'), { set: true, hint: '7890', updatedAt: r.updatedAt });
  assert.equal(store.getToken('web'), TOK);
  const iv1 = Buffer.from(db.prepare('SELECT iv FROM repo_secrets').get().iv);
  store.setToken('web', 'ghp_second_token_abcd');
  assert.equal(store.getToken('web'), 'ghp_second_token_abcd');
  assert.ok(!iv1.equals(Buffer.from(db.prepare('SELECT iv FROM repo_secrets').get().iv)));
  assert.throws(() => store.setToken('api', TOK), TypeError);
  assert.throws(() => store.setToken('loc', TOK), TypeError);
  assert.throws(() => store.setToken('nope', TOK), TypeError);
  assert.throws(() => store.setToken('web', ''), TypeError);
  assert.throws(() => store.setToken('web', 'ghp_bad value'), (e) => e instanceof TypeError && !e.message.includes('ghp_bad'));
  const json = JSON.stringify([store.list(), store.get('web'), store.tokenInfo('web')]);
  assert.ok(!json.includes('ghp_second_token_abcd'));
  for (const row of db.prepare('SELECT ciphertext FROM repo_secrets').all()) {
    assert.ok(!Buffer.from(row.ciphertext).includes('ghp_second_token_abcd'));
  }
});

test('deleting a repo cascades to its secrets', () => {
  const { db, store } = fresh();
  store.insertRepo(https('web'));
  store.setToken('web', TOK);
  db.prepare('DELETE FROM repos WHERE id = ?').run('web');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM repo_secrets').get().n, 0);
});

test('AAD binding: a row whose repo url changed origin no longer decrypts', () => {
  const { db, store } = fresh();
  store.insertRepo(https('web'));
  store.setToken('web', TOK);
  db.prepare("UPDATE repos SET url='https://evil.example/o/r.git' WHERE id='web'").run();
  assert.throws(() => store.getToken('web'), (e) => e instanceof SecretDecryptError && e.reason === 'auth-failed' && !e.message.includes(TOK));
  db.prepare("UPDATE repos SET url='git@h:o/r' WHERE id='web'").run();
  assert.throws(() => store.getToken('web'), (e) => e instanceof SecretDecryptError && e.reason === 'malformed');
});

test('verifySecrets reports secrets the ring cannot decrypt', () => {
  const { db } = fresh();
  const s1 = createRepoStore({ db, keyRing: createKeyRing(K1) });
  s1.insertRepo(https('web'));
  s1.setToken('web', TOK);
  assert.deepEqual(s1.verifySecrets(), []);
  const s2 = createRepoStore({ db, keyRing: createKeyRing(K2) });
  assert.deepEqual(s2.verifySecrets(), [{ repoId: 'web', name: 'token', reason: 'unknown-key' }]);
});

test('rotateSecrets re-encrypts only rows on a previous key; hint/updated_at untouched', () => {
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
  const { db } = fresh(undefined, now);
  const s1 = createRepoStore({ db, keyRing: createKeyRing(K1), now });
  for (const id of ['web', 'app', 'new']) s1.insertRepo(https(id));
  s1.setToken('web', 'ghp_web_token_1111');
  s1.setToken('app', 'ghp_app_token_2222');
  const s2only = createRepoStore({ db, keyRing: createKeyRing(K2), now });
  s2only.setToken('new', 'ghp_new_token_3333');
  const before = new Map(db.prepare('SELECT * FROM repo_secrets').all().map((r) => [r.repo_id, r]));
  const rot = createRepoStore({ db, keyRing: createKeyRing(K2, [K1]), now });
  assert.deepEqual(rot.tx(() => rot.rotateSecrets()), { count: 2, fromKeyIds: [kid(K1)] });
  const rows = db.prepare('SELECT * FROM repo_secrets').all();
  for (const r of rows) {
    assert.equal(r.key_id, kid(K2));
    assert.equal(r.updated_at, before.get(r.repo_id).updated_at);
    assert.equal(r.hint, before.get(r.repo_id).hint);
  }
  const newRow = rows.find((r) => r.repo_id === 'new');
  assert.ok(Buffer.from(newRow.iv).equals(Buffer.from(before.get('new').iv)));
  assert.deepEqual(['web', 'app', 'new'].map((id) => s2only.getToken(id)), ['ghp_web_token_1111', 'ghp_app_token_2222', 'ghp_new_token_3333']);
});

test('verifyAndRotateSecrets: wrong key -> SecretCheckError; rotation logged + audited once; PREVIOUS warning', () => {
  const { db } = fresh();
  const s1 = createRepoStore({ db, keyRing: createKeyRing(K1) });
  s1.insertRepo(https('web'));
  s1.insertRepo(https('app'));
  s1.setToken('web', TOK);
  s1.setToken('app', 'ghp_app_token_2222');

  const wrongRing = createKeyRing(K2);
  const l0 = logger();
  const err = (() => {
    try {
      verifyAndRotateSecrets({ store: createRepoStore({ db, keyRing: wrongRing }), keyRing: wrongRing, log: l0.log });
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof SecretCheckError);
  assert.match(err.message, /repo "web": token cannot be decrypted with MASTER_KEY\/MASTER_KEY_PREVIOUS/);
  assert.ok(!err.message.includes(TOK));

  const ring = createKeyRing(K2, [K1]);
  const store = createRepoStore({ db, keyRing: ring });
  const l1 = logger();
  assert.deepEqual(verifyAndRotateSecrets({ store, keyRing: ring, log: l1.log }), { rotated: 2 });
  assert.deepEqual(l1.info, [`Re-encrypted 2 secret(s) to key ${kid(K2)}`]);
  const audits = db.prepare("SELECT * FROM audit_log WHERE action = 'key.rotate'").all();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'system');
  assert.deepEqual(JSON.parse(audits[0].details), { to: kid(K2), from: [kid(K1)], count: 2 });

  const l2 = logger();
  assert.deepEqual(verifyAndRotateSecrets({ store, keyRing: ring, log: l2.log }), { rotated: 0 });
  assert.deepEqual(l2.info, []);
  assert.equal(l2.warn.length, 1);
  assert.match(l2.warn[0], /MASTER_KEY_PREVIOUS is set but no stored secret uses it/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'key.rotate'").get().n, 1);

  const single = createKeyRing(K2);
  const l3 = logger();
  verifyAndRotateSecrets({ store: createRepoStore({ db, keyRing: single }), keyRing: single, log: l3.log });
  assert.deepEqual([l3.info, l3.warn], [[], []]);
});

test('checkStoredRepos: fatal problems vs warnings', () => {
  const { db, store } = fresh();
  store.insertRepo(https('web'));
  store.insertRepo(https('tok'));
  store.setToken('tok', TOK);
  store.insertRepo({ id: 'loc', url: '/x.git', kind: 'local', defaultBranch: 'main', sshKeyPath: null });
  store.insertRepo({ id: 'api', url: 'git@h:o/r', kind: 'ssh', defaultBranch: 'main', sshKeyPath: path.join(tmp, 'missing') });
  store.insertRepo({ id: 'ok', url: 'git@h:o/r', kind: 'ssh', defaultBranch: 'main', sshKeyPath: sshKey });
  let r = checkStoredRepos(store, { allowLocal: false, sshKeysDir: tmp });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /repo "loc": .*ALLOW_LOCAL_REPOS/);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => /repo "api": sshKeyPath does not exist: .*its jobs will fail/.test(w)));
  assert.ok(r.warnings.some((w) => /repo "web": no token stored/.test(w)));

  r = checkStoredRepos(store, { allowLocal: true, sshKeysDir: tmp });
  assert.deepEqual(r.problems, []);
  r = checkStoredRepos(store, { allowLocal: true, sshKeysDir: '/run/elsewhere' });
  assert.ok(r.problems.some((p) => /repo "api": sshKeyPath must be inside SSH_KEYS_DIR/.test(p)));

  db.prepare("UPDATE repos SET kind = 'ssh', ssh_key_path = NULL WHERE id = 'tok'").run();
  r = checkStoredRepos(store, { allowLocal: true, sshKeysDir: tmp });
  assert.ok(r.problems.some((p) => /repo "tok": stored kind does not match/.test(p)), r.problems.join(' | '));
});

test('meta upsert and audit rows', () => {
  const { db, store } = fresh();
  assert.equal(store.getMeta('k'), null);
  store.setMeta('k', 'v1');
  store.setMeta('k', 'v2');
  assert.equal(store.getMeta('k'), 'v2');
  store.insertRepo(https('web'));
  store.insertAudit({ actor: 'admin', action: 'repo.create', repoId: 'web', ip: '127.0.0.1', details: { a: 1 } });
  store.insertAudit({ actor: 'system', action: 'x' });
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].repo_id, 'web');
  assert.equal(rows[0].ip, '127.0.0.1');
  assert.deepEqual(JSON.parse(rows[0].details), { a: 1 });
  assert.equal(rows[1].repo_id, null);
  assert.equal(rows[1].details, '{}');
});

test('updateRepo changes url/kind/branch/key and bumps updatedAt; setEnabled toggles enabled', () => {
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
  const { store } = fresh(undefined, now);
  store.insertRepo(https('web'));
  const before = store.get('web');
  store.updateRepo('web', { id: 'web', url: 'git@h:o/r', kind: 'ssh', defaultBranch: 'dev', sshKeyPath: sshKey });
  const r = store.get('web');
  assert.deepEqual([r.url, r.kind, r.defaultBranch, r.sshKeyPath], ['git@h:o/r', 'ssh', 'dev', sshKey]);
  assert.equal(r.createdAt, before.createdAt);
  assert.ok(r.updatedAt > before.updatedAt);
  store.setEnabled('web', false);
  assert.equal(store.get('web').enabled, false);
  assert.ok(store.get('web').updatedAt > r.updatedAt);
  store.setEnabled('web', true);
  assert.equal(store.get('web').enabled, true);
});

test('deleteRepo cascades secrets; deleteSecret removes the token', () => {
  const { db, store } = fresh();
  store.insertRepo(https('web'));
  store.insertRepo(https('app'));
  store.setToken('web', TOK);
  store.setToken('app', TOK);
  store.deleteSecret('app');
  assert.equal(store.tokenInfo('app'), null);
  assert.equal(store.getToken('app'), null);
  assert.notEqual(store.tokenInfo('web'), null);
  store.deleteRepo('web');
  assert.equal(store.get('web'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM repo_secrets').get().n, 0);
});

test('listAudit: newest first, id cursor, repo filter, parsed details', () => {
  const { store } = fresh();
  for (const [repoId, n] of [['web', 1], ['api', 2], ['web', 3], ['api', 4], ['web', 5]]) {
    store.insertAudit({ actor: 'ops', action: 'repo.update', repoId, details: { n } });
  }
  let r = store.listAudit({ limit: 2 });
  assert.deepEqual(r.entries.map((e) => e.id), [5, 4]);
  assert.equal(r.next, 4);
  r = store.listAudit({ limit: 2, before: 4 });
  assert.deepEqual(r.entries.map((e) => e.id), [3, 2]);
  assert.equal(r.next, 2);
  r = store.listAudit({ limit: 2, before: 2 });
  assert.deepEqual(r.entries.map((e) => e.id), [1]);
  assert.equal(r.next, null);
  r = store.listAudit({ repoId: 'api' });
  assert.deepEqual(r.entries.map((e) => e.repo_id), ['api', 'api']);
  assert.equal(r.next, null);
  assert.deepEqual(r.entries[0].details, { n: 4 });
  assert.deepEqual(Object.keys(r.entries[0]).sort(), ['action', 'actor', 'at', 'details', 'id', 'ip', 'repo_id']);
  assert.equal(r.entries[0].ip, null);
  assert.deepEqual(store.listAudit().entries.length, 5);
});

test('findEnvVarsHoldingTokens: names (never values) of env vars equal to a stored token >= 8 chars, sorted', () => {
  const { store } = fresh();
  store.tx(() => {
    store.insertRepo(https('web')); store.setToken('web', TOK);
    store.insertRepo(https('short')); store.setToken('short', 'abc');
    store.insertRepo({ id: 'loc', url: '/srv/x.git', kind: 'local', defaultBranch: 'main', sshKeyPath: null });
  });
  const env = { Z_PAT: ` ${TOK} `, A_PAT: TOK, NEAR: `${TOK}x`, SHORT: 'abc', UNSET: undefined };
  assert.deepEqual(findEnvVarsHoldingTokens(store, env), [{ name: 'A_PAT', repoId: 'web' }, { name: 'Z_PAT', repoId: 'web' }]);
  assert.deepEqual(findEnvVarsHoldingTokens(fresh().store, env), []);
});
