// Covers: fail-fast config (prerequisite for T1, T6, T10) incl. the repos file. Pure unit tests — no processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, expandHome, redactConfig } from '../src/config.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const sshKey = path.join(cwd, 'id_test');
fs.writeFileSync(sshKey, 'key');

let fileNo = 0;
/** Write a repos file into cwd and return its name (relative, like a user would set REPOS_FILE). */
function reposFile(doc) {
  const name = `repos-${++fileNo}.json`;
  fs.writeFileSync(path.join(cwd, name), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return name;
}
const LOCAL = { repos: [{ id: 'local', url: '/tmp/origin.git' }] };
const BASE = { REPOS_FILE: reposFile(LOCAL), API_KEY: 'k' };

function problemsOf(env) {
  try {
    loadConfig(env, { cwd });
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected ConfigError');
}

test('minimal valid env (REPOS_FILE + API_KEY) -> defaults applied', () => {
  const c = loadConfig(BASE, { cwd });
  assert.equal(c.apiKey, 'k');
  assert.equal(c.claudeBin, 'claude');
  assert.equal(c.claudePermissionMode, 'bypassPermissions');
  assert.equal(c.claudeMaxTurns, 50);
  assert.equal(c.jobTimeoutMs, 1_800_000);
  assert.equal(c.gitTimeoutMs, 300_000);
  assert.equal(c.logsTailLines, 50);
  assert.equal(c.port, 8080);
  assert.equal(c.claudeAuthProbe, true);
  assert.equal(c.maxConcurrentJobs, 1);
  assert.equal(c.jobsFile, null);
  assert.equal(c.jobRetentionMax, 1000);
  assert.equal(c.adminUser, 'admin');
  assert.equal(c.adminPassword, null);
  assert.equal(c.workspaceRoot, path.join(cwd, 'workspaces'));
  assert.equal(c.repos.length, 1);
  assert.deepEqual({ ...c.repos[0] }, {
    id: 'local', url: '/tmp/origin.git', kind: 'local', defaultBranch: 'main',
    workspaceDir: path.join(cwd, 'workspaces', 'local'), sshKeyPath: null, tokenEnv: null, token: null,
  });
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.repos));
  assert.ok(Object.isFrozen(c.repos[0]));
});

test('missing repos file and API_KEY -> one ConfigError listing both problems', () => {
  const problems = problemsOf({});
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('REPOS_FILE not found')));
  assert.ok(problems.some((p) => p.includes('API_KEY')));
});

test('empty / whitespace values count as unset', () => {
  const c = loadConfig({ ...BASE, PORT: '', CLAUDE_BIN: ' ', MAX_CONCURRENT_JOBS: '  ' }, { cwd });
  assert.equal(c.port, 8080);
  assert.equal(c.claudeBin, 'claude');
  assert.equal(c.maxConcurrentJobs, 1);
});

test('repos file: multiple repos, each with its own credential; tokens read from the named env vars', () => {
  const file = reposFile({
    workspaceRoot: './ws',
    repos: [
      { id: 'web', url: 'https://github.com/org/web.git', defaultBranch: 'dev', auth: { tokenEnv: 'GIT_TOKEN_WEB' } },
      { id: 'api', url: 'git@github.com:org/api.git', auth: { sshKeyPath: sshKey } },
      { id: 'tools', url: 'ssh://git@github.com/org/tools.git', auth: { sshKeyPath: sshKey } },
    ],
  });
  const c = loadConfig({ API_KEY: 'k', REPOS_FILE: file, GIT_TOKEN_WEB: 'ghp_web' }, { cwd });
  assert.deepEqual(c.repos.map((r) => [r.id, r.kind, r.defaultBranch]), [['web', 'https', 'dev'], ['api', 'ssh', 'main'], ['tools', 'ssh', 'main']]);
  assert.equal(c.repos[0].token, 'ghp_web');
  assert.equal(c.repos[0].tokenEnv, 'GIT_TOKEN_WEB');
  assert.equal(c.repos[1].sshKeyPath, sshKey);
  assert.equal(c.repos[1].workspaceDir, path.join(cwd, 'ws', 'api'));
});

test('repos file: every remote repo must have its own credential; no global fallback', () => {
  const file = reposFile({ repos: [
    { id: 'web', url: 'https://github.com/org/web.git' },
    { id: 'api', url: 'git@github.com:org/api.git' },
    { id: 'mixed', url: 'https://github.com/org/m.git', auth: { tokenEnv: 'T_M', sshKeyPath: sshKey } },
    { id: 'loc', url: '/srv/x.git', auth: { tokenEnv: 'T_M' } },
  ] });
  const problems = problemsOf({ API_KEY: 'k', REPOS_FILE: file, T_M: 'x' });
  assert.ok(problems.some((p) => p.includes('"web"') && p.includes('set auth.tokenEnv')));
  assert.ok(problems.some((p) => p.includes('"api"') && p.includes('set auth.sshKeyPath')));
  assert.ok(problems.some((p) => p.includes('"mixed"') && p.includes('sshKeyPath only applies to ssh')));
  assert.ok(problems.some((p) => p.includes('"loc"') && p.includes('local repos take no auth')));
});

test('repos file: bad ids, duplicates, bad urls, bad branch, missing token env var, missing key -> all listed', () => {
  const file = reposFile({ repos: [
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
  ] });
  const problems = problemsOf({ API_KEY: 'k', REPOS_FILE: file, X: 'x' });
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
});

test('repos file: invalid JSON / wrong shape / empty list', () => {
  assert.match(problemsOf({ API_KEY: 'k', REPOS_FILE: reposFile('{ nope') })[0], /not valid JSON/);
  assert.match(problemsOf({ API_KEY: 'k', REPOS_FILE: reposFile('[]') })[0], /JSON object/);
  assert.match(problemsOf({ API_KEY: 'k', REPOS_FILE: reposFile({ repos: [] }) })[0], /non-empty array/);
});

test('repos file: workspaceRoot may not be the service dir or a parent of it', () => {
  for (const root of ['.', '..', '/']) {
    const problems = problemsOf({ API_KEY: 'k', REPOS_FILE: reposFile({ workspaceRoot: root, repos: LOCAL.repos }) });
    assert.ok(problems.some((p) => p.includes('workspaceRoot must not be the service directory')), root);
  }
});

test('old single-repo env vars are rejected with a pointer to REPOS_FILE', () => {
  const problems = problemsOf({ ...BASE, REPO_URL: '/x.git', GIT_TOKEN: 'ghp_old' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /REPO_URL, GIT_TOKEN are no longer supported; define repos in REPOS_FILE/);
  assert.ok(!problems[0].includes('ghp_old'));
});

test('MAX_CONCURRENT_JOBS, JOBS_FILE, JOB_RETENTION_MAX, ADMIN_* parsed and checked', () => {
  const c = loadConfig({ ...BASE, MAX_CONCURRENT_JOBS: '3', JOBS_FILE: './data/jobs.jsonl', JOB_RETENTION_MAX: '10', ADMIN_USER: 'ops', ADMIN_PASSWORD: 'long-enough-pw' }, { cwd });
  assert.equal(c.maxConcurrentJobs, 3);
  assert.equal(c.jobsFile, path.join(cwd, 'data', 'jobs.jsonl'));
  assert.equal(c.jobRetentionMax, 10);
  assert.equal(c.adminUser, 'ops');
  assert.equal(c.adminPassword, 'long-enough-pw');
  assert.match(problemsOf({ ...BASE, MAX_CONCURRENT_JOBS: '0' })[0], /MAX_CONCURRENT_JOBS/);
  assert.match(problemsOf({ ...BASE, ADMIN_PASSWORD: 'short' })[0], /at least 8/);
  assert.match(problemsOf({ ...BASE, API_KEY: 'same-secret-123', ADMIN_PASSWORD: 'same-secret-123' })[0], /must differ from API_KEY/);
  assert.match(problemsOf({ ...BASE, ADMIN_USER: 'a:b' })[0], /ADMIN_USER/);
});

test('ConfigError message never contains secret values', () => {
  const file = reposFile({ repos: [{ id: 'web', url: 'https://github.com/o/r.git', auth: { tokenEnv: 'TOK' } }] });
  const env = { API_KEY: 'secret-api-key-123', TOK: 'ghp_secret_token_456', ADMIN_PASSWORD: 'secret-api-key-123', REPOS_FILE: file, PORT: 'nope', CLAUDE_MAX_TURNS: 'x' };
  try {
    loadConfig(env, { cwd });
    assert.fail('expected ConfigError');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    for (const secret of [env.API_KEY, env.TOK]) assert.ok(!err.message.includes(secret));
  }
});

test('redactConfig masks the API key, admin password and every repo token', () => {
  const file = reposFile({ repos: [{ id: 'web', url: 'https://github.com/o/r.git', auth: { tokenEnv: 'TOK' } }, ...LOCAL.repos] });
  const c = loadConfig({ API_KEY: 'k', TOK: 'ghp_x', ADMIN_PASSWORD: 'admin-pw-123', REPOS_FILE: file }, { cwd });
  const r = redactConfig(c);
  assert.equal(r.apiKey, '***');
  assert.equal(r.adminPassword, '***');
  assert.equal(r.repos[0].token, '***');
  assert.equal(r.repos[1].token, null);
  assert.equal(r.repos[0].tokenEnv, 'TOK');
  const json = JSON.stringify(r);
  for (const s of ['ghp_x', 'admin-pw-123']) assert.ok(!json.includes(s));
  assert.equal(c.repos[0].token, 'ghp_x'); // original untouched
});

test('JOB_TIMEOUT_SECONDS=10 -> jobTimeoutMs 10000 (T10 setup); "abc", "0", "1.5" rejected', () => {
  assert.equal(loadConfig({ ...BASE, JOB_TIMEOUT_SECONDS: '10' }, { cwd }).jobTimeoutMs, 10_000);
  for (const v of ['abc', '0', '1.5', '-3']) {
    const problems = problemsOf({ ...BASE, JOB_TIMEOUT_SECONDS: v });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /JOB_TIMEOUT_SECONDS/);
  }
  assert.equal(loadConfig({ ...BASE, PORT: '0' }, { cwd }).port, 0);
  assert.match(problemsOf({ ...BASE, PORT: '70000' })[0], /PORT/);
});

test('CLAUDE_PERMISSION_MODE outside PERMISSION_MODES rejected', () => {
  assert.equal(loadConfig({ ...BASE, CLAUDE_PERMISSION_MODE: 'plan' }, { cwd }).claudePermissionMode, 'plan');
  assert.match(problemsOf({ ...BASE, CLAUDE_PERMISSION_MODE: 'yolo' })[0], /CLAUDE_PERMISSION_MODE/);
});

test('CLAUDE_AUTH_PROBE parses true/false/1/0/yes/no; other values rejected', () => {
  const cases = { true: true, TRUE: true, '1': true, yes: true, Yes: true, false: false, '0': false, no: false, NO: false };
  for (const [v, expected] of Object.entries(cases)) {
    assert.equal(loadConfig({ ...BASE, CLAUDE_AUTH_PROBE: v }, { cwd }).claudeAuthProbe, expected, v);
  }
  assert.match(problemsOf({ ...BASE, CLAUDE_AUTH_PROBE: 'maybe' })[0], /CLAUDE_AUTH_PROBE/);
});

test('expandHome: "~", "~/a", "/abs", "rel" ', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/a/b', '/home/u'), '/home/u/a/b');
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
  assert.equal(expandHome('rel', '/home/u'), 'rel');
  assert.equal(expandHome('~other', '/home/u'), '~other');
});

test('a repo may use GIT_TOKEN as its own tokenEnv without tripping the legacy-var check', () => {
  const file = reposFile({ repos: [{ id: 'web', url: 'https://github.com/o/r.git', auth: { tokenEnv: 'GIT_TOKEN' } }] });
  const c = loadConfig({ API_KEY: 'k', REPOS_FILE: file, GIT_TOKEN: 'ghp_1' }, { cwd });
  assert.equal(c.repos[0].token, 'ghp_1');
});
