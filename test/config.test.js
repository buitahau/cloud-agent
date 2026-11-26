// Covers: fail-fast config (prerequisite for T1, T6, T10), env only (repos live in the DB). Pure unit tests — no processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, expandHome, redactConfig, withoutRepoImportVars } from '../src/config.js';
import { deriveKeyId } from '../src/secrets.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const B1 = crypto.randomBytes(32).toString('base64');
const B2 = crypto.randomBytes(32).toString('base64');
const BASE = { API_KEY: 'k', MASTER_KEY: B1 };

function problemsOf(env) {
  try {
    loadConfig(env, { cwd });
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected ConfigError');
}

test('minimal valid env (API_KEY + MASTER_KEY) -> defaults applied', () => {
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
  assert.equal(c.dbFile, path.join(cwd, 'data', 'cloud-agent.db'));
  assert.equal(c.workspaceRoot, path.join(cwd, 'workspaces'));
  assert.ok(!('reposFile' in c) && !('reposFileExplicit' in c));
  assert.equal(c.allowLocalRepos, false);
  assert.equal(c.trustProxy, false);
  assert.equal(c.sshKeysDir, '/run/ssh-keys');
  assert.equal(c.keyRing.currentKeyId, deriveKeyId(Buffer.from(B1, 'base64')));
  assert.equal(c.keyRing.keyIds.length, 1);
  assert.ok(!('repos' in c));
  assert.ok(Object.isFrozen(c));
});

test('missing API_KEY and MASTER_KEY -> one ConfigError listing both problems', () => {
  const problems = problemsOf({});
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /API_KEY is required/.test(p)));
  assert.ok(problems.some((p) => /MASTER_KEY is required/.test(p)));
});

test('empty / whitespace values count as unset', () => {
  const c = loadConfig({ ...BASE, PORT: '', CLAUDE_BIN: ' ', MAX_CONCURRENT_JOBS: '  ' }, { cwd });
  assert.equal(c.port, 8080);
  assert.equal(c.claudeBin, 'claude');
  assert.equal(c.maxConcurrentJobs, 1);
});

test('MASTER_KEY: format, must differ from API_KEY, PREVIOUS without current, key ring of two', () => {
  const short = crypto.randomBytes(31).toString('base64');
  assert.ok(problemsOf({ ...BASE, MASTER_KEY: short }).some((p) => /MASTER_KEY must be base64/.test(p)));
  assert.ok(problemsOf({ API_KEY: B1, MASTER_KEY: B1 }).some((p) => /MASTER_KEY must differ from API_KEY/.test(p)));
  const p = problemsOf({ API_KEY: 'k', MASTER_KEY_PREVIOUS: B2 });
  assert.ok(p.some((x) => /MASTER_KEY is required/.test(x)));
  assert.ok(p.some((x) => /MASTER_KEY_PREVIOUS is set but MASTER_KEY is not/.test(x)));
  const c = loadConfig({ ...BASE, MASTER_KEY_PREVIOUS: B2 }, { cwd });
  assert.equal(c.keyRing.keyIds.length, 2);
  assert.equal(c.keyRing.keyIds[1], deriveKeyId(Buffer.from(B2, 'base64')));
});

test('WORKSPACE_ROOT may not be the service dir or a parent of it; relative resolved against cwd', () => {
  for (const root of ['.', '..', '/']) {
    const problems = problemsOf({ ...BASE, WORKSPACE_ROOT: root });
    assert.ok(problems.some((p) => /WORKSPACE_ROOT must not be the service directory/.test(p)), root);
  }
  assert.equal(loadConfig({ ...BASE, WORKSPACE_ROOT: './ws' }, { cwd }).workspaceRoot, path.join(cwd, 'ws'));
});

test('DB_FILE resolved against cwd and may not live inside WORKSPACE_ROOT', () => {
  assert.ok(problemsOf({ ...BASE, DB_FILE: './workspaces/x.db' }).some((p) => /DB_FILE must not be inside WORKSPACE_ROOT/.test(p)));
  assert.equal(loadConfig({ ...BASE, DB_FILE: './d/x.db' }, { cwd }).dbFile, path.join(cwd, 'd', 'x.db'));
});

test('ALLOW_LOCAL_REPOS, SSH_KEYS_DIR, TRUST_PROXY', () => {
  assert.equal(loadConfig({ ...BASE, ALLOW_LOCAL_REPOS: 'yes' }, { cwd }).allowLocalRepos, true);
  assert.match(problemsOf({ ...BASE, ALLOW_LOCAL_REPOS: 'maybe' })[0], /ALLOW_LOCAL_REPOS/);
  assert.equal(loadConfig({ ...BASE, TRUST_PROXY: 'yes' }, { cwd }).trustProxy, true);
  assert.throws(() => loadConfig({ ...BASE, TRUST_PROXY: 'maybe' }, { cwd }), (e) => e instanceof ConfigError && /TRUST_PROXY/.test(e.message));
  assert.equal(loadConfig({ ...BASE, SSH_KEYS_DIR: '~/keys' }, { cwd }).sshKeysDir, path.join(os.homedir(), 'keys'));
});

test('retired env vars (single-repo and repos.json era) -> one problem naming each, sorted; values never shown', () => {
  const problems = problemsOf({ ...BASE, REPO_URL: '/x.git', GIT_SSH_KEY_PATH: '/k', REPOS_FILE: './repos.json',
    GIT_TOKEN: 'ghp_old_secret', GIT_TOKEN_WEB: 'ghp_web_secret', MY_PAT: 'x' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^GIT_SSH_KEY_PATH, GIT_TOKEN, GIT_TOKEN_WEB, REPOS_FILE, REPO_URL are no longer read: repos and their tokens are stored in the database \(DB_FILE\)/);
  assert.match(problems[0], /repos\.json mount from docker-compose\.yml/);
  assert.match(problems[0], /node src\/cli\.js import <file>/);
  assert.doesNotMatch(problems[0], /MY_PAT|ghp_/);
  const one = problemsOf({ ...BASE, GIT_TOKEN_A: 'x' })[0];
  assert.match(one, /^GIT_TOKEN_A is no longer read: .*Remove it from \.env/);
  assert.doesNotMatch(one, /mount/);
  assert.equal(loadConfig({ ...BASE, REPOS_FILE: '', GIT_TOKEN_X: '  ' }, { cwd }).apiKey, 'k'); // blank = unset
});

test('withoutRepoImportVars drops REPOS_FILE / GIT_TOKEN / GIT_TOKEN_* only', () => {
  const env = withoutRepoImportVars({ ...BASE, REPOS_FILE: 'r', GIT_TOKEN: 'a', GIT_TOKEN_B: 'b', REPO_URL: '/x', KEEP: '1' });
  assert.deepEqual(Object.keys(env).sort(), ['API_KEY', 'KEEP', 'MASTER_KEY', 'REPO_URL']);
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
  const env = { API_KEY: 'secret-api-key-123', ADMIN_PASSWORD: 'secret-api-key-123', MASTER_KEY: 'not-a-valid-key-secret', MASTER_KEY_PREVIOUS: 'prev-secret-xyz', PORT: 'nope', CLAUDE_MAX_TURNS: 'x' };
  try {
    loadConfig(env, { cwd });
    assert.fail('expected ConfigError');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    for (const secret of [env.API_KEY, env.MASTER_KEY, env.MASTER_KEY_PREVIOUS]) assert.ok(!err.message.includes(secret), secret);
  }
});

test('redactConfig masks the API key, admin password and master keys (key ids only)', () => {
  const c = loadConfig({ ...BASE, ADMIN_PASSWORD: 'admin-pw-123', MASTER_KEY_PREVIOUS: B2 }, { cwd });
  const r = redactConfig(c);
  assert.equal(r.apiKey, '***');
  assert.equal(r.adminPassword, '***');
  assert.match(String(r.masterKey), /^\*\*\* \(key id [0-9a-f]{16}\)$/);
  assert.equal(r.masterKeyPrevious.length, 1);
  assert.match(r.masterKeyPrevious[0], /^\*\*\* \(key id [0-9a-f]{16}\)$/);
  assert.ok(!('keyRing' in r));
  const json = JSON.stringify(r);
  for (const s of [B1, B2, 'admin-pw-123']) assert.ok(!json.includes(s));
  assert.equal(c.adminPassword, 'admin-pw-123'); // original untouched
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
