// Covers: fail-fast config (prerequisite for T1, T6, T10). Pure unit tests — no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, expandHome, redactConfig } from '../src/config.js';

const BASE = { REPO_URL: '/tmp/origin.git', API_KEY: 'k' };
const cwd = '/srv/app';

function problemsOf(env) {
  try {
    loadConfig(env, { cwd });
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected ConfigError');
}

test('minimal valid env (REPO_URL + API_KEY) -> defaults applied', () => {
  const c = loadConfig(BASE, { cwd });
  assert.equal(c.repoUrl, '/tmp/origin.git');
  assert.equal(c.apiKey, 'k');
  assert.equal(c.repoBranch, 'main');
  assert.equal(c.claudeBin, 'claude');
  assert.equal(c.claudePermissionMode, 'bypassPermissions');
  assert.equal(c.claudeMaxTurns, 50);
  assert.equal(c.jobTimeoutMs, 1_800_000);
  assert.equal(c.gitTimeoutMs, 300_000);
  assert.equal(c.logsTailLines, 50);
  assert.equal(c.port, 8080);
  assert.equal(c.claudeAuthProbe, true);
  assert.equal(c.gitSshKeyPath, null);
  assert.equal(c.gitToken, null);
  assert.equal(c.workspaceDir, path.resolve(cwd, './workspace'));
  assert.ok(Object.isFrozen(c));
});

test('missing REPO_URL and API_KEY -> one ConfigError listing both problems', () => {
  const problems = problemsOf({});
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('REPO_URL')));
  assert.ok(problems.some((p) => p.includes('API_KEY')));
});

test('empty / whitespace values count as unset', () => {
  const problems = problemsOf({ REPO_URL: '   ', API_KEY: '' });
  assert.equal(problems.length, 2);
  const c = loadConfig({ ...BASE, REPO_BRANCH: '  ', PORT: '', CLAUDE_BIN: ' ', REPO_URL: '  /x.git  ' }, { cwd });
  assert.equal(c.repoBranch, 'main');
  assert.equal(c.port, 8080);
  assert.equal(c.claudeBin, 'claude');
  assert.equal(c.repoUrl, '/x.git');
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

test('REPO_BRANCH invalid (e.g. "-x", "a..b") rejected', () => {
  assert.equal(loadConfig({ ...BASE, REPO_BRANCH: 'dev' }, { cwd }).repoBranch, 'dev');
  for (const b of ['-x', 'a..b']) assert.match(problemsOf({ ...BASE, REPO_BRANCH: b })[0], /REPO_BRANCH/);
});

test('GIT_SSH_KEY_PATH "~/x" expanded; non-existent file rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  try {
    const key = path.join(dir, 'id_test');
    fs.writeFileSync(key, 'key');
    assert.equal(loadConfig({ ...BASE, GIT_SSH_KEY_PATH: key }, { cwd }).gitSshKeyPath, key);
    const problems = problemsOf({ ...BASE, GIT_SSH_KEY_PATH: '~/definitely-missing-key-xyz' });
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes(path.join(os.homedir(), 'definitely-missing-key-xyz')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLAUDE_AUTH_PROBE parses true/false/1/0/yes/no; other values rejected', () => {
  const cases = { true: true, TRUE: true, '1': true, yes: true, Yes: true, false: false, '0': false, no: false, NO: false };
  for (const [v, expected] of Object.entries(cases)) {
    assert.equal(loadConfig({ ...BASE, CLAUDE_AUTH_PROBE: v }, { cwd }).claudeAuthProbe, expected, v);
  }
  assert.match(problemsOf({ ...BASE, CLAUDE_AUTH_PROBE: 'maybe' })[0], /CLAUDE_AUTH_PROBE/);
});

test('ConfigError message never contains API_KEY / GIT_TOKEN values', () => {
  const env = {
    API_KEY: 'secret-api-key-123',
    GIT_TOKEN: 'ghp_secret_token_456',
    PORT: 'nope',
    CLAUDE_MAX_TURNS: 'x',
  };
  try {
    loadConfig(env, { cwd });
    assert.fail('expected ConfigError');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    for (const secret of [env.API_KEY, env.GIT_TOKEN]) {
      assert.ok(!err.message.includes(secret));
    }
  }
});

test('redactConfig masks secrets', () => {
  const c = loadConfig({ ...BASE, GIT_TOKEN: 'ghp_x' }, { cwd });
  const r = redactConfig(c);
  assert.equal(r.apiKey, '***');
  assert.equal(r.gitToken, '***');
  assert.equal(r.repoUrl, c.repoUrl);
  const json = JSON.stringify(r);
  for (const s of ['ghp_x']) assert.ok(!json.includes(s));
  assert.equal(redactConfig(loadConfig(BASE, { cwd })).gitToken, null);
});

test('expandHome: "~", "~/a", "/abs", "rel" ', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/a/b', '/home/u'), '/home/u/a/b');
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
  assert.equal(expandHome('rel', '/home/u'), 'rel');
  assert.equal(expandHome('~other', '/home/u'), '~other');
});
