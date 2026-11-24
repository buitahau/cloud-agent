// Covers: T9 (failure reported), T10 (timeout -> status timeout + process killed), JSON parsing, flags/env.
// Two styles: stub `run` (pure classification) and real runProcess + test-support/fake-claude.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClaudeRunner, buildClaudeArgs, buildClaudeEnv, parseClaudeJson, classifyClaudeRun,
} from '../src/claudeRunner.js';
import { FAKE_CLAUDE } from '../test-support/gitFixture.js';

/** @returns {import('../src/lib/processRunner.js').RunResult} */
const R = (over = {}) => ({
  code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
  truncated: false, spawnError: null, durationMs: 1, ...over,
});
const resultJson = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: 's1',
  total_cost_usd: 0.01, num_turns: 1, duration_ms: 10, ...over,
});

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')); }
const baseOpts = { claudeBin: FAKE_CLAUDE, permissionMode: 'bypassPermissions', maxTurns: 50, timeoutMs: 10_000, killGraceMs: 200 };

test('buildClaudeArgs exact vector (prompt NOT in argv)', () => {
  assert.deepEqual(buildClaudeArgs({ permissionMode: 'bypassPermissions', maxTurns: 50 }),
    ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--max-turns', '50']);
});

test('buildClaudeEnv strips ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/CLAUDECODE/CLAUDE_CODE_ENTRYPOINT, sets token, no mutation', () => {
  const base = {
    PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP: 'x',
  };
  const snapshot = { ...base };
  const env = buildClaudeEnv(base, 'tok');
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  assert.deepEqual(base, snapshot);
  assert.equal(buildClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'pre' }, null).CLAUDE_CODE_OAUTH_TOKEN, 'pre');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in buildClaudeEnv({}, null), false);
});

test('parseClaudeJson: single object; warning lines before JSON; garbage -> null; non-result object -> null', () => {
  const obj = resultJson();
  assert.deepEqual(parseClaudeJson(JSON.stringify(obj)), obj);
  assert.deepEqual(parseClaudeJson(`\n  ${JSON.stringify(obj)}  \n`), obj);
  assert.deepEqual(parseClaudeJson(`Warning: something\n{not json\n${JSON.stringify(obj)}\n`), obj);
  assert.equal(parseClaudeJson('this is not json\nstill not'), null);
  assert.equal(parseClaudeJson(''), null);
  assert.equal(parseClaudeJson(JSON.stringify({ type: 'assistant', is_error: false })), null);
  assert.equal(parseClaudeJson(JSON.stringify({ type: 'result' })), null);
  assert.equal(parseClaudeJson('[1,2]'), null);
});

test('classify: exit 0 + is_error false -> succeeded with result + meta', () => {
  const parsed = resultJson({ result: 'all good' });
  const out = classifyClaudeRun(R(), parsed, 1000);
  assert.equal(out.outcome, 'succeeded');
  assert.equal(out.result, 'all good');
  assert.equal(out.error, null);
  assert.deepEqual(out.meta, {
    session_id: 's1', total_cost_usd: 0.01, num_turns: 1, duration_ms: 10, subtype: 'success', is_error: false,
  });
});

test('classify: exit 1 + is_error true (auth 401 shape, subtype "success") -> failed, error contains result text', () => {
  const parsed = resultJson({ is_error: true, result: 'Failed to authenticate. API Error: 401' });
  const out = classifyClaudeRun(R({ code: 1 }), parsed, 1000);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.error, 'claude reported an error (success): Failed to authenticate. API Error: 401');
  assert.equal(out.result, 'Failed to authenticate. API Error: 401');
  // is_error false but non-zero exit is also a failure
  assert.equal(classifyClaudeRun(R({ code: 1 }), resultJson(), 1000).outcome, 'failed');
  // long error text truncated to 2000 chars
  const long = classifyClaudeRun(R({ code: 1 }), resultJson({ is_error: true, result: 'x'.repeat(5000) }), 1000);
  assert.equal(long.error.length, 2000);
});

test('classify: error_max_turns -> failed', () => {
  const parsed = resultJson({ subtype: 'error_max_turns', is_error: true, result: undefined });
  const out = classifyClaudeRun(R({ code: 1 }), parsed, 1000);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.error, 'claude reported an error (error_max_turns): no result text');
  assert.equal(out.result, null);
  assert.equal(out.meta.subtype, 'error_max_turns');
});

test('classify: unparseable + stderr -> failed, error mentions exit code and last stderr line', () => {
  const out = classifyClaudeRun(R({ code: 2, stdout: 'garbage', stderr: 'first\nboom\n\n' }), null, 1000);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.error, 'claude exited with 2; unparseable output: boom');
  assert.equal(out.meta, null);
  assert.equal(out.result, null);
  const noStderr = classifyClaudeRun(R({ code: null, signal: 'SIGSEGV' }), null, 1000);
  assert.equal(noStderr.error, 'claude exited with SIGSEGV; unparseable output: no stderr');
});

test('classify: spawnError -> failed "Failed to start claude"', () => {
  const out = classifyClaudeRun(R({ code: null, spawnError: new Error('spawn claude ENOENT') }), null, 1000);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.error, 'Failed to start claude: spawn claude ENOENT');
  // precedence: timedOut beats everything, aborted next
  assert.equal(classifyClaudeRun(R({ timedOut: true, code: 0 }), resultJson(), 10_000).error,
    'Timed out after 10s; claude process killed');
  assert.equal(classifyClaudeRun(R({ timedOut: true }), null, 10_000).outcome, 'timeout');
  assert.equal(classifyClaudeRun(R({ aborted: true }), null, 1000).error, 'Aborted: service shutting down');
});

test('T9 via fake: [[fake:error]] -> failed; logs include [claude] summary line', async () => {
  const lines = [];
  const runner = createClaudeRunner(baseOpts);
  const out = await runner.run({ prompt: '[[fake:error]]', cwd: os.tmpdir(), log: (l) => lines.push(l) });
  assert.equal(out.outcome, 'failed');
  assert.match(out.error, /^claude reported an error \(error_during_execution\): fake failure/);
  assert.equal(lines[0], `[claude] $ ${FAKE_CLAUDE} -p --output-format json --permission-mode bypassPermissions --max-turns 50`);
  assert.ok(lines.some((l) => /^\[claude\] exit=1 subtype=error_during_execution turns=1 cost_usd=0 duration_ms=5$/.test(l)), lines.join('\n'));

  const g = [];
  const garbage = await runner.run({ prompt: '[[fake:garbage]]', cwd: os.tmpdir(), log: (l) => g.push(l) });
  assert.equal(garbage.outcome, 'failed');
  assert.equal(garbage.error, 'claude exited with 2; unparseable output: boom');
  assert.ok(g.includes('[claude:stdout] this is not json'));
  assert.ok(g.includes('[claude:stderr] boom'));
});

test('T10 via fake: [[fake:sleep=30]] with timeoutMs 500 -> outcome timeout, grandchild killed', async () => {
  const dir = tmpdir();
  const pidfile = path.join(dir, 'pids');
  try {
    const runner = createClaudeRunner({
      ...baseOpts, timeoutMs: 500, baseEnv: { ...process.env, FAKE_CLAUDE_PIDFILE: pidfile },
    });
    const t0 = Date.now();
    const out = await runner.run({ prompt: '[[fake:sleep=30]]', cwd: dir });
    assert.equal(out.outcome, 'timeout');
    assert.equal(out.error, 'Timed out after 0.5s; claude process killed');
    assert.ok(Date.now() - t0 < 4000);
    const pids = fs.readFileSync(pidfile, 'utf8').trim().split(' ').map(Number);
    for (const pid of pids) {
      let alive = true;
      for (let i = 0; i < 80 && alive; i++) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 25)); } catch { alive = false; }
      }
      assert.equal(alive, false, `pid ${pid} still alive`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('via fake: cwd is passed through ([[fake:pwd]]) and FAKE_CLAUDE_RECORD shows flags + token + stripped env', async () => {
  const dir = tmpdir();
  const rec = path.join(dir, 'record.jsonl');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'ws-')));
  try {
    const runner = createClaudeRunner({
      ...baseOpts,
      permissionMode: 'acceptEdits',
      maxTurns: 7,
      oauthToken: 'sk-ant-oat01-test',
      baseEnv: { ...process.env, FAKE_CLAUDE_RECORD: rec, ANTHROPIC_API_KEY: 'should-go', CLAUDECODE: '1' },
    });
    const out = await runner.run({ prompt: '-starts with dash [[fake:pwd]]', cwd: work });
    assert.equal(out.outcome, 'succeeded');
    assert.equal(out.result, work);
    const entry = JSON.parse(fs.readFileSync(rec, 'utf8').trim().split('\n').pop());
    assert.deepEqual(entry.argv, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', '7']);
    assert.equal(entry.stdin, '-starts with dash [[fake:pwd]]');
    assert.equal(entry.cwd, work);
    assert.deepEqual(entry.env, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', ANTHROPIC_API_KEY: null, CLAUDECODE: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('via fake: stderr lines are logged as "[claude:stderr] ..."', async () => {
  const lines = [];
  const out = await createClaudeRunner(baseOpts).run({ prompt: '[[fake:stderr]]', cwd: os.tmpdir(), log: (l) => lines.push(l) });
  assert.equal(out.outcome, 'succeeded');
  assert.deepEqual(lines.filter((l) => l.startsWith('[claude:stderr]')),
    ['[claude:stderr] fake stderr line 1', '[claude:stderr] fake stderr line 2', '[claude:stderr] fake stderr line 3']);
  // stdout JSON is not line-logged
  assert.ok(!lines.some((l) => l.startsWith('[claude:stdout]')));
});

test('stub run: never rejects even if injected run throws; spawnError path', async () => {
  const boom = createClaudeRunner({ ...baseOpts, run: async () => { throw new Error('kaput'); } });
  const out = await boom.run({ prompt: 'x', cwd: '/' });
  assert.equal(out.outcome, 'failed');
  assert.match(out.error, /kaput/);

  const missing = createClaudeRunner({ ...baseOpts, claudeBin: '/nonexistent/claude' });
  const out2 = await missing.run({ prompt: 'x', cwd: os.tmpdir() });
  assert.equal(out2.outcome, 'failed');
  assert.match(out2.error, /^Failed to start claude: .*ENOENT/);
});
