// Covers: T1 at process level — `node src/index.js` with CLAUDE_BIN pointing at test-support/fake-claude.js.
// Spawn with cwd = a fresh tmp dir (so the project's .env is NOT loaded by dotenv) and an explicit env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CLAUDE } from '../test-support/gitFixture.js';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(REPO_|WORKSPACE_DIR|GIT_|CLAUDE|ANTHROPIC_|API_KEY|PORT|JOB_TIMEOUT|LOGS_TAIL|FAKE_CLAUDE)/.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * Spawn src/index.js from a temp cwd. Resolves helpers to wait for output / exit.
 */
function startService(extraEnv) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
  const child = spawn(process.execPath, [INDEX], {
    cwd,
    env: cleanEnv({
      REPO_URL: path.join(cwd, 'origin.git'),
      API_KEY: 'k',
      PORT: '0',
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
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
  return { child, out: () => stdout, err: () => stderr, waitFor, withTimeout, cleanup };
}

test('T1 valid: logs "Claude auth OK" and "Listening on :<port>" (PORT=0); kill with SIGTERM -> exit 0', async () => {
  const s = startService({});
  try {
    await s.waitFor(/Claude auth OK \(oauth_token, 0\.0\.0-fake \(Claude Code\), probe passed\)/);
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
  const s = startService({ FAKE_CLAUDE_AUTH: 'logged_out', CLAUDE_CODE_OAUTH_TOKEN: '' });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /Claude auth check failed at status/);
  } finally { s.cleanup(); }
});

test('missing REPO_URL -> exits 1 with "Invalid configuration"', async () => {
  const s = startService({ REPO_URL: '' });
  try {
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 1);
    assert.match(s.err(), /Invalid configuration/);
    assert.match(s.err(), /REPO_URL is required/);
  } finally { s.cleanup(); }
});

test('CLAUDE_AUTH_PROBE=false -> starts with "probe skipped" even with an invalid token', async () => {
  const s = startService({ FAKE_CLAUDE_AUTH: 'invalid', CLAUDE_AUTH_PROBE: 'false' });
  try {
    await s.waitFor(/Claude auth OK \(oauth_token, .*probe skipped\)/);
    await s.waitFor(/Listening on :\d+/);
    s.child.kill('SIGINT');
    const { code } = await s.withTimeout(10_000);
    assert.equal(code, 0);
  } finally { s.child.kill('SIGKILL'); s.cleanup(); }
});
