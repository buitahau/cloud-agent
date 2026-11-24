// Covers: T10 core mechanics (timeout kills the WHOLE process tree), spawn errors, stdin delivery.
// Uses real processes: test-support/fake-claude.js and `sh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, killGroup } from '../src/lib/processRunner.js';
import { FAKE_CLAUDE } from '../test-support/gitFixture.js';

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
async function waitDead(pid, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

test('captures stdout/stderr and exit code (sh -c "echo a; echo b 1>&2; exit 3")', async () => {
  const r = await runProcess({ cmd: 'sh', args: ['-c', 'echo a; echo b 1>&2; exit 3'] });
  assert.equal(r.code, 3);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'a\n');
  assert.equal(r.stderr, 'b\n');
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, false);
  assert.equal(r.truncated, false);
  assert.equal(r.spawnError, null);
  assert.ok(r.durationMs >= 0);
});

test('stdin is delivered and closed (fake-claude -p echoes it)', async () => {
  const r = await runProcess({ cmd: FAKE_CLAUDE, args: ['-p', '--output-format', 'json'], stdin: 'hello there' });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).result, 'echo: hello there');
});

test('stdin undefined -> child sees EOF immediately (does not hang)', async () => {
  const r = await runProcess({ cmd: 'cat', args: [], timeoutMs: 3000, killGraceMs: 200 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('onLine receives stderr lines; stdout lines only when lineStdout !== false', async () => {
  const script = 'printf "o1\\no2"; printf "e1\\ne2\\n" 1>&2';
  const seen = [];
  await runProcess({ cmd: 'sh', args: ['-c', script], onLine: (l, s) => seen.push(`${s}:${l}`) });
  assert.deepEqual(seen.filter((x) => x.startsWith('stdout:')), ['stdout:o1', 'stdout:o2']);
  assert.deepEqual(seen.filter((x) => x.startsWith('stderr:')), ['stderr:e1', 'stderr:e2']);

  const seen2 = [];
  const r = await runProcess({
    cmd: 'sh', args: ['-c', script], lineStdout: false,
    onLine: (l, s) => { seen2.push(`${s}:${l}`); throw new Error('ignored'); },
  });
  assert.deepEqual(seen2, ['stderr:e1', 'stderr:e2']);
  assert.equal(r.stdout, 'o1\no2');
});

test('ENOENT binary -> resolves with spawnError, never rejects', async () => {
  const r = await runProcess({ cmd: '/nonexistent/definitely-not-here', args: [] });
  assert.ok(r.spawnError instanceof Error);
  assert.equal(/** @type {any} */ (r.spawnError).code, 'ENOENT');
  assert.equal(r.code, null);
});

test('T10: timeout kills process group — grandchild from [[fake:sleep=30]] is dead afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const pidfile = path.join(dir, 'pids');
  const t0 = Date.now();
  try {
    const r = await runProcess({
      cmd: FAKE_CLAUDE, args: ['-p'], stdin: '[[fake:sleep=30]]',
      timeoutMs: 500, killGraceMs: 200, env: { ...process.env, FAKE_CLAUDE_PIDFILE: pidfile },
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.aborted, false);
    const [selfPid, grandPid] = fs.readFileSync(pidfile, 'utf8').trim().split(' ').map(Number);
    assert.ok(selfPid > 0 && grandPid > 0);
    assert.equal(await waitDead(selfPid), true, 'fake claude still alive');
    assert.equal(await waitDead(grandPid), true, 'grandchild sleep still alive');
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGTERM-ignoring child gets SIGKILL after killGraceMs', async () => {
  const t0 = Date.now();
  const r = await runProcess({ cmd: 'sh', args: ['-c', 'trap "" TERM; sleep 30'], timeoutMs: 200, killGraceMs: 300 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(elapsed >= 450, `resolved too early (${elapsed}ms)`);
  assert.ok(elapsed < 3000, `resolved too late (${elapsed}ms)`);
});

test('AbortSignal aborts like a timeout with aborted=true', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await runProcess({ cmd: 'sleep', args: ['30'], signal: ac.signal, killGraceMs: 200 });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.signal, 'SIGTERM');

  const pre = new AbortController();
  pre.abort();
  const r2 = await runProcess({ cmd: 'sleep', args: ['30'], signal: pre.signal, killGraceMs: 200 });
  assert.equal(r2.aborted, true);
});

test('output beyond maxCaptureBytes is dropped and truncated=true', async () => {
  const r = await runProcess({ cmd: 'sh', args: ['-c', 'head -c 5000 /dev/zero | tr "\\0" x'], maxCaptureBytes: 1000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.truncated, true);
});

test('killGroup never throws (bad / gone pids)', () => {
  assert.doesNotThrow(() => killGroup(999999999, 'SIGTERM'));
  assert.doesNotThrow(() => killGroup(/** @type {any} */ (undefined), 'SIGTERM'));
});
