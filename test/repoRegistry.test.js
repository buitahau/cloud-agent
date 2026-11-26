// Covers: repoRegistry builds one GitSync per stored repo, reads tokens lazily from the store (never holds
// them), and passes the secret env names through.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRepoRegistry } from '../src/repoRegistry.js';
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
