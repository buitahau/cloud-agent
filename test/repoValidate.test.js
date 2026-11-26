// Covers: validation of one repo definition and of a repo token (src/lib/repoValidate.js). Pure unit tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRepoInput, validateToken, isSameOrInside, MAX_TOKEN_LENGTH } from '../src/lib/repoValidate.js';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const key = path.join(dir, 'id_test');
fs.writeFileSync(key, 'key');

function problems(input, opts) {
  const r = validateRepoInput(input, opts);
  assert.equal(r.ok, false, JSON.stringify(input));
  return r.problems;
}
const hasProblem = (input, re, opts) => {
  const p = problems(input, opts);
  assert.ok(p.some((x) => re.test(x)), `${re}: ${p.join(' | ')}`);
};

test('valid https repo: defaults applied, extra fields ignored', () => {
  const r = validateRepoInput({ id: 'web', url: 'https://github.com/o/r.git', extra: 1 });
  assert.deepEqual(r, { ok: true, repo: { id: 'web', url: 'https://github.com/o/r.git', kind: 'https', defaultBranch: 'main', sshKeyPath: null } });
});

test('valid ssh (ssh:// and scp-style) with a key inside sshKeysDir; local with allowLocal', () => {
  for (const url of ['ssh://git@github.com/o/r.git', 'git@github.com:o/r.git']) {
    const r = validateRepoInput({ id: 'api', url, defaultBranch: 'dev', sshKeyPath: ` ${key} ` }, { sshKeysDir: dir });
    assert.ok(r.ok, url);
    assert.equal(r.repo.kind, 'ssh');
    assert.equal(r.repo.sshKeyPath, key);
    assert.equal(r.repo.defaultBranch, 'dev');
  }
  const l = validateRepoInput({ id: 'loc', url: '/srv/x.git', sshKeyPath: null }, { allowLocal: true });
  assert.ok(l.ok);
  assert.equal(l.repo.kind, 'local');
  assert.equal(l.repo.sshKeyPath, null);
});

test('not an object -> single problem', () => {
  for (const v of [null, 'x', [], 1]) assert.deepEqual(validateRepoInput(v), { ok: false, problems: ['must be an object'] });
});

test('ported id/url/branch problems', () => {
  hasProblem({ id: 'Bad_Id', url: 'https://h/o/r' }, /id must be/);
  hasProblem({ id: 'admin', url: 'https://h/o/r' }, /id must be/);
  hasProblem({ id: 'rce', url: 'ext::sh' }, /remote-helper/);
  hasProblem({ id: 'creds', url: 'https://user:pass@github.com/o/r.git' }, /must not embed credentials/);
  hasProblem({ id: 'plain', url: 'http://github.com/o/r.git' }, /http:\/\/ is not allowed/);
  hasProblem({ id: 'branch', url: 'https://h/o/r', defaultBranch: '--upload-pack=x' }, /defaultBranch/);
});

test('local repos need allowLocal', () => {
  hasProblem({ id: 'loc', url: '/srv/x.git' }, /ALLOW_LOCAL_REPOS=true/);
  hasProblem({ id: 'loc', url: 'file:///srv/x.git' }, /ALLOW_LOCAL_REPOS=true/);
});

test('credential kind rules', () => {
  hasProblem({ id: 'api', url: 'git@github.com:o/r.git' }, /set sshKeyPath/);
  hasProblem({ id: 'web', url: 'https://h/o/r', sshKeyPath: key }, /only applies to ssh URLs/);
  hasProblem({ id: 'loc', url: '/x.git', sshKeyPath: key }, /only applies to ssh URLs/, { allowLocal: true });
});

test('sshKeyPath rules', () => {
  const ssh = (sshKeyPath, opts = { sshKeysDir: dir }) => ({ input: { id: 'api', url: 'git@h:o/r', sshKeyPath }, opts });
  const check = ({ input, opts }, re) => hasProblem(input, re, opts);
  check(ssh(`${dir}/../x`), /inside SSH_KEYS_DIR/);
  check(ssh('/etc/x'), /inside SSH_KEYS_DIR/);
  check(ssh(dir), /inside SSH_KEYS_DIR/);
  check(ssh('rel/key'), /absolute/);
  check(ssh("/a'b"), /single quote/);
  check(ssh(''), /non-empty string/);
  check(ssh(5), /non-empty string/);
  check(ssh(path.join(dir, 'missing')), /does not exist/);
  assert.ok(validateRepoInput(ssh(path.join(dir, 'missing')).input, { sshKeysDir: dir, checkKeyFile: false }).ok);
  // no sshKeysDir -> any absolute existing path is fine
  assert.ok(validateRepoInput(ssh(key).input).ok);
});

test('validateToken', () => {
  for (const t of ['', 'a b', 'a\n', 'x'.repeat(MAX_TOKEN_LENGTH + 1), null, 5]) assert.equal(validateToken(t).ok, false, JSON.stringify(t));
  assert.deepEqual(validateToken('x'.repeat(MAX_TOKEN_LENGTH)), { ok: true, token: 'x'.repeat(MAX_TOKEN_LENGTH) });
  const r = validateToken('ghp_secret with space');
  assert.equal(r.ok, false);
  assert.match(r.error, /whitespace/);
  assert.ok(!r.error.includes('ghp_secret'));
});

test('isSameOrInside', () => {
  assert.equal(isSameOrInside('/a', '/a'), true);
  assert.equal(isSameOrInside('/a/b', '/a'), true);
  assert.equal(isSameOrInside('/ab', '/a'), false);
  assert.equal(isSameOrInside('/', '/a'), false);
  assert.equal(isSameOrInside('/a', '/'), true);
});
