// Covers: T1 at process level — `node src/index.js` with CLAUDE_BIN pointing at test-support/fake-claude.js.
// Spawn with cwd = a fresh tmp dir (so the project's .env is NOT loaded by dotenv) and an explicit env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CLAUDE, createGitFixture } from '../test-support/gitFixture.js';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const MK = crypto.randomBytes(32).toString('base64');

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(REPO_|REPOS_FILE|WORKSPACE_DIR|GIT_|CLAUDE|ANTHROPIC_|API_KEY|PORT|JOB_|LOGS_TAIL|FAKE_CLAUDE|MAX_CONCURRENT|ADMIN_|MASTER_KEY|DB_FILE|WORKSPACE_ROOT|SSH_KEYS_DIR|ALLOW_LOCAL_REPOS)/.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * Spawn src/index.js from a temp cwd. Resolves helpers to wait for output / exit.
 * repos: undefined -> two local repos; null -> no repos.json written.
 */
function startService(extraEnv, { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-')), repos } = {}) {
  if (repos !== null && !fs.existsSync(path.join(cwd, 'repos.json'))) {
    const doc = { repos: repos ?? [{ id: 'one', url: path.join(cwd, 'one.git') }, { id: 'two', url: path.join(cwd, 'two.git') }] };
    fs.writeFileSync(path.join(cwd, 'repos.json'), JSON.stringify(doc));
  }
  const child = spawn(process.execPath, [INDEX], {
    cwd,
    env: cleanEnv({
      API_KEY: 'k',
      MASTER_KEY: MK,
      ALLOW_LOCAL_REPOS: 'true',
      PORT: '0',
      CLAUDE_BIN: FAKE_CLAUDE,
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const waitFor = async (re, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = re.exec(stdout);
      if (m) return m;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${re}; stdout=${stdout} stderr=${stderr}`);
  };
  const withTimeout = (ms) => Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`no exit within ${ms}ms; stderr=${stderr}`)); }, ms)),
  ]);
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  return { cwd, child, out: () => stdout, err: () => stderr, waitFor, withTimeout, cleanup };
}

test('T1 valid: logs "Claude auth OK" and "Listening on :<port>" (PORT=0); kill with SIGTERM -> exit 0', async () => {
  const s = startService({});
  try {
    await s.waitFor(/Claude auth OK \(claude\.ai, 0\.0\.0-fake \(Claude Code\), probe passed\)/);
    const m = await s.waitFor(/Listening on :(\d+)/);
    const port = Number(m[1]);
    assert.ok(port > 0);
    assert.ok(!s.out().includes('sk-ant-oat01-fake'), 'token leaked into logs');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    s.child.kill('SIGTERM');
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 0);
    assert.match(s.out(), /Shutting down/);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});

test('T1 invalid token (FAKE_CLAUDE_AUTH=invalid) -> exits 1 within 10s, stderr has "Claude auth check failed"', async () => {
  const s = startService({ FAKE_CLAUDE_AUTH: 'invalid' });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /Claude auth check failed at probe: .*401/);
    assert.ok(!s.out().includes('Listening'));
  } finally { s.cleanup(); }
});

test('T1 logged out (FAKE_CLAUDE_AUTH=logged_out) -> exits 1', async () => {
  const s = startService({ FAKE_CLAUDE_AUTH: 'logged_out' });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /Claude auth check failed at status/);
  } finally { s.cleanup(); }
});

test('empty database and no repos.json -> starts with 0 repos', async () => {
  const s = startService({}, { repos: null });
  try {
    await s.waitFor(/Repos: \(none\)/);
    const port = Number((await s.waitFor(/Listening on :(\d+)/))[1]);
    const r = await fetch(`http://127.0.0.1:${port}/repos`, { headers: { 'x-api-key': 'k' } });
    assert.deepEqual(await r.json(), []);
    assert.match(s.err(), /no repos configured/);
    assert.match(s.out(), /REPOS_FILE not found/);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});

test('missing MASTER_KEY -> exits 1 before claude is ever run', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  const rec = path.join(cwd, 'rec.jsonl');
  const s = startService({ MASTER_KEY: '', FAKE_CLAUDE_RECORD: rec }, { cwd });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /MASTER_KEY is required/);
    assert.equal(fs.existsSync(rec), false);
  } finally { s.cleanup(); }
});

test('wrong MASTER_KEY fails before the Claude probe; MASTER_KEY_PREVIOUS rotates; token never logged', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  const rec = path.join(cwd, 'rec.jsonl');
  const TOKEN = 'ghp_startup_secret_1234';
  const K2 = crypto.randomBytes(32).toString('base64');
  const repos = [{ id: 'web', url: 'https://example.invalid/o/r.git', auth: { tokenEnv: 'GIT_TOKEN_WEB' } }];
  const base = { CLAUDE_AUTH_PROBE: 'false', GIT_TOKEN_WEB: TOKEN };
  const noSecrets = (s) => {
    for (const v of [TOKEN, MK, K2]) {
      assert.ok(!s.out().includes(v) && !s.err().includes(v), 'secret value in output');
    }
  };
  let s;
  try {
    s = startService(base, { cwd, repos });
    await s.waitFor(/Imported 1 repo from/);
    await s.waitFor(/Listening on :\d+/);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    noSecrets(s);

    s = startService({ ...base, MASTER_KEY: K2, FAKE_CLAUDE_RECORD: rec }, { cwd, repos });
    assert.equal((await s.withTimeout(10_000)).code, 1);
    assert.match(s.err(), /repo "web": token cannot be decrypted with MASTER_KEY\/MASTER_KEY_PREVIOUS/);
    assert.equal(fs.existsSync(rec), false);
    assert.ok(!s.out().includes('Claude auth OK'));
    noSecrets(s);

    s = startService({ ...base, MASTER_KEY: K2, MASTER_KEY_PREVIOUS: MK }, { cwd, repos });
    await s.waitFor(/Re-encrypted 1 secret\(s\) to key [0-9a-f]{16}/);
    await s.waitFor(/Listening on :\d+/);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    assert.match(s.err(), /GIT_TOKEN_WEB is ignored/);
    assert.match(s.err(), /MASTER_KEY_PREVIOUS is set but no stored secret uses it/);
    noSecrets(s);

    s = startService({ ...base, MASTER_KEY: K2 }, { cwd, repos });
    await s.waitFor(/Listening on :\d+/);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    noSecrets(s);
  } finally { s?.child.kill('SIGKILL'); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('invalid repos.json on first boot -> exits 1, nothing imported', async () => {
  const s = startService({}, { repos: [{ id: 'web', url: 'https://example.invalid/o/r.git', auth: { tokenEnv: 'GIT_TOKEN_NOPE' } }] });
  try {
    assert.equal((await s.withTimeout(10_000)).code, 1);
    assert.match(s.err(), /Import of repos\.json failed/);
    assert.match(s.err(), /GIT_TOKEN_NOPE \(auth.tokenEnv\) is not set/);
  } finally { s.cleanup(); }
});

test('local repos need ALLOW_LOCAL_REPOS=true', async () => {
  const s = startService({ ALLOW_LOCAL_REPOS: '' });
  try {
    assert.equal((await s.withTimeout(10_000)).code, 1);
    assert.match(s.err(), /ALLOW_LOCAL_REPOS=true/);
  } finally { s.cleanup(); }
});

test('old REPO_URL setup -> exits 1 pointing at the database', async () => {
  const s = startService({ REPO_URL: '/tmp/x.git' });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /REPO_URL is no longer supported; repos are stored in the database/);
  } finally { s.cleanup(); }
});

test('logs the configured repos and admin state; /admin is off without ADMIN_PASSWORD', async () => {
  const s = startService({ MAX_CONCURRENT_JOBS: '2' });
  try {
    await s.waitFor(/Imported 2 repos from .*repos\.json/);
    await s.waitFor(/Repos: one, two \(max 2 concurrent jobs\)/);
    await s.waitFor(/Admin dashboard: disabled/);
    const port = Number((await s.waitFor(/Listening on :(\d+)/))[1]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/`)).status, 404);
    const r = await fetch(`http://127.0.0.1:${port}/repos`, { headers: { 'x-api-key': 'k' } });
    assert.deepEqual((await r.json()).map((x) => x.id), ['one', 'two']);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(s.cwd, 'data', 'cloud-agent.db')).mode & 0o777, 0o600);
    }
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});

test('JOBS_FILE: finished jobs survive a restart (end to end with a real repo + fake claude)', async () => {
  const fx = createGitFixture();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  const repos = [{ id: 'fx', url: fx.originUrl }];
  const env = { JOBS_FILE: './data/jobs.jsonl', ADMIN_PASSWORD: 'admin-secret-pw', CLAUDE_AUTH_PROBE: 'false' };
  let s = startService(env, { cwd, repos });
  try {
    let port = Number((await s.waitFor(/Listening on :(\d+)/))[1]);
    const res = await fetch(`http://127.0.0.1:${port}/fx/run-agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ prompt: 'hi [[fake:success]]', branch: 'main' }),
    });
    assert.equal(res.status, 202);
    const { id } = await res.json();
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`http://127.0.0.1:${port}/fx/run-agent/${id}`, { headers: { 'x-api-key': 'k' } })).json();
      if (['succeeded', 'failed', 'timeout'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.status, 'succeeded', job.error);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    assert.ok(fs.existsSync(path.join(cwd, 'workspaces', 'fx', '.git')), 'repo cloned under workspaces/<id>');

    s = startService(env, { cwd, repos });
    await s.waitFor(/Listening/);
    await s.waitFor(/Jobs file: .*jobs\.jsonl \(1 jobs loaded, 0 interrupted\)/);
    port = Number((await s.waitFor(/Listening on :(\d+)/))[1]);
    const again = await (await fetch(`http://127.0.0.1:${port}/fx/run-agent/${id}`, { headers: { 'x-api-key': 'k' } })).json();
    assert.equal(again.status, 'succeeded');
    assert.equal(again.result, job.result);
    const admin = await fetch(`http://127.0.0.1:${port}/admin/api/repos/fx`, {
      headers: { authorization: `Basic ${Buffer.from('admin:admin-secret-pw').toString('base64')}` },
    });
    const repo = await admin.json();
    assert.equal(repo.health, 'ok');
    assert.equal(repo.cloned, true);
    assert.deepEqual(repo.recent_jobs.map((j) => j.id), [id]);
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
    assert.match(s.err(), /REPOS_FILE .* is ignored/);
    assert.doesNotMatch(s.out(), /Imported/);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); fx.cleanup(); }
});

test('CLAUDE_AUTH_PROBE=false -> starts with "probe skipped" even with an invalid login', async () => {
  const s = startService({ FAKE_CLAUDE_AUTH: 'invalid', CLAUDE_AUTH_PROBE: 'false' });
  try {
    await s.waitFor(/Claude auth OK \(claude\.ai, .*probe skipped\)/);
    await s.waitFor(/Listening on :\d+/);
    s.child.kill('SIGINT');
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 0);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});

test('claude never sees API_KEY, ADMIN_PASSWORD, MASTER_KEY or repo tokens', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  const rec = path.join(cwd, 'rec.jsonl');
  const repos = [{ id: 'web', url: 'https://example.invalid/o/r.git', auth: { tokenEnv: 'MY_REPO_PAT' } }];
  const s = startService({
    ADMIN_PASSWORD: 'admin-secret-pw', MASTER_KEY_PREVIOUS: crypto.randomBytes(32).toString('base64'), MY_REPO_PAT: 'pat-secret',
    GIT_TOKEN_OLD: 'old', FAKE_CLAUDE_RECORD: rec,
  }, { cwd, repos });
  try {
    await s.waitFor(/Claude auth OK/);
    await s.waitFor(/Listening on :\d+/);   // signal handlers are installed by then
    const entries = fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(entries.length >= 2, `expected auth status + probe records, got ${entries.length}`);
    for (const e of entries) {
      for (const k of ['API_KEY', 'ADMIN_PASSWORD', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'MY_REPO_PAT', 'GIT_TOKEN_OLD']) {
        assert.ok(!e.envKeys.includes(k), `${k} reached claude (${e.argv.join(' ')})`);
      }
    }
    assert.ok(!s.out().includes('pat-secret'), 'repo token leaked into logs');
    s.child.kill('SIGTERM');
    assert.equal((await s.withTimeout(10_000)).code, 0);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});
