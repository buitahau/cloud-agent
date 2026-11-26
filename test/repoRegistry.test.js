// Covers: repoRegistry passes the repos' secret env names through to every GitSync it creates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepoRegistry } from '../src/repoRegistry.js';

const REPO = {
  id: 'a', url: 'https://h/o/r.git', kind: 'https', defaultBranch: 'main', workspaceDir: '/tmp/x/a',
  sshKeyPath: null, tokenEnv: 'MY_PAT', token: 't',
};

function stubFactory() {
  const seen = [];
  const factory = (o) => { seen.push(o); return { sync: async () => ({ commit: 'abc' }) }; };
  return { seen, factory };
}

test('createRepoRegistry forwards secretEnvNames to each GitSync (default [])', () => {
  const a = stubFactory();
  createRepoRegistry([REPO], { gitTimeoutMs: 1000, secretEnvNames: ['MY_PAT'], gitSyncFactory: a.factory });
  assert.equal(a.seen.length, 1);
  assert.deepEqual(a.seen[0].secretEnvNames, ['MY_PAT']);
  assert.equal(a.seen[0].token, 't');

  const b = stubFactory();
  createRepoRegistry([REPO], { gitTimeoutMs: 1000, gitSyncFactory: b.factory });
  assert.deepEqual(b.seen[0].secretEnvNames, []);
});
