// Covers: T1 (startup auth check) at the module level, using test-support/fake-claude.js.
// Process-level T1 (exit code + "Claude auth OK" log) is in startup.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaudeAuth, ClaudeAuthError } from '../src/claudeAuth.js';
import { FAKE_CLAUDE } from '../test-support/gitFixture.js';

function withRecord(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const rec = path.join(dir, 'rec.jsonl');
  const read = () => (fs.existsSync(rec)
    ? fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return Promise.resolve(fn(rec, read)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const rejectsWithStep = (p, step, re) => assert.rejects(p, (err) => {
  assert.ok(err instanceof ClaudeAuthError, String(err));
  assert.equal(err.step, step);
  assert.match(err.message, new RegExp(`^Claude auth check failed at ${step}: `));
  if (re) assert.match(err.message, re);
  return true;
});

test('T1 valid: fake claude logged in + probe ok -> { ok:true, authMethod:"oauth_token", probed:true }', async () => {
  const r = await checkClaudeAuth({ claudeBin: FAKE_CLAUDE, oauthToken: 'tok', probe: true });
  assert.deepEqual(r, { ok: true, version: '0.0.0-fake (Claude Code)', authMethod: 'oauth_token', probed: true });
});

test('T1 invalid token: FAKE_CLAUDE_AUTH=invalid -> ClaudeAuthError step "probe" mentioning 401/authenticate', async () => {
  await rejectsWithStep(
    checkClaudeAuth({ claudeBin: FAKE_CLAUDE, oauthToken: 'bad-token-value', baseEnv: { ...process.env, FAKE_CLAUDE_AUTH: 'invalid' } }),
    'probe', /401|authenticate/,
  );
  // and the token itself never shows up in the message
  try {
    await checkClaudeAuth({ claudeBin: FAKE_CLAUDE, oauthToken: 'bad-token-value', baseEnv: { ...process.env, FAKE_CLAUDE_AUTH: 'invalid' } });
  } catch (err) {
    assert.ok(!err.message.includes('bad-token-value'));
    assert.match(err.message, /setup-token/);
  }
});

test('T1 missing login: FAKE_CLAUDE_AUTH=logged_out -> ClaudeAuthError step "status"', async () => {
  await rejectsWithStep(
    checkClaudeAuth({ claudeBin: FAKE_CLAUDE, baseEnv: { ...process.env, FAKE_CLAUDE_AUTH: 'logged_out' } }),
    'status', /not logged in/,
  );
});

test('T1 missing binary: claudeBin "/nonexistent/claude" -> ClaudeAuthError step "binary"', async () => {
  await rejectsWithStep(checkClaudeAuth({ claudeBin: '/nonexistent/claude' }), 'binary', /\/nonexistent\/claude/);
});

test('probe:false skips the -p call (FAKE_CLAUDE_RECORD has no -p entry)', () => withRecord(async (rec, read) => {
  const r = await checkClaudeAuth({ claudeBin: FAKE_CLAUDE, probe: false, baseEnv: { ...process.env, FAKE_CLAUDE_RECORD: rec } });
  assert.equal(r.probed, false);
  const entries = read();
  assert.equal(entries.length, 1); // only `auth status` records (--version doesn't)
  assert.deepEqual(entries[0].argv, ['auth', 'status', '--json']);
  assert.ok(!entries.some((e) => e.argv.includes('-p')));
}));

test('probe runs in os.tmpdir() and receives CLAUDE_CODE_OAUTH_TOKEN via env', () => withRecord(async (rec, read) => {
  await checkClaudeAuth({
    claudeBin: FAKE_CLAUDE, oauthToken: 'sk-ant-oat01-probe', probe: true,
    baseEnv: { ...process.env, FAKE_CLAUDE_RECORD: rec, ANTHROPIC_API_KEY: 'strip-me' },
  });
  const probe = read().find((e) => e.argv.includes('-p'));
  assert.ok(probe);
  assert.deepEqual(probe.argv, ['-p', '--output-format', 'json', '--max-turns', '1']);
  assert.equal(probe.cwd, fs.realpathSync(os.tmpdir()));
  assert.equal(probe.stdin, 'Reply with exactly: OK');
  assert.equal(probe.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-probe');
  assert.equal(probe.env.ANTHROPIC_API_KEY, null);
}));

test('stub run: unparseable auth status -> step "status"; probe exit 0 but is_error -> step "probe"', async () => {
  const ok = { code: 0, signal: null, stderr: '', timedOut: false, aborted: false, truncated: false, spawnError: null, durationMs: 1 };
  const mk = (statusOut, probeOut, probeCode = 0) => async ({ args }) => {
    if (args[0] === '--version') return { ...ok, stdout: '9.9.9\n' };
    if (args[0] === 'auth') return { ...ok, stdout: statusOut };
    return { ...ok, code: probeCode, stdout: probeOut };
  };
  await rejectsWithStep(checkClaudeAuth({ claudeBin: 'x', run: mk('not json', '') }), 'status');
  await rejectsWithStep(checkClaudeAuth({
    claudeBin: 'x',
    run: mk('{"loggedIn":true,"authMethod":"claude.ai"}', '{"type":"result","subtype":"success","is_error":true,"result":"nope"}'),
  }), 'probe', /nope/);
  const r = await checkClaudeAuth({
    claudeBin: 'x',
    run: mk('{"loggedIn":true,"authMethod":"claude.ai"}', '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'),
  });
  assert.deepEqual(r, { ok: true, version: '9.9.9', authMethod: 'claude.ai', probed: true });
});
