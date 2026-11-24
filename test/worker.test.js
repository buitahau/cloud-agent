// Covers: T3 (status progression), T11 (sequential FIFO, one at a time), T9 (failure keeps worker alive),
// T10 (timeout status end-to-end through the worker), T12 (job 2 clean after job 1 junk).
// Uses real jobStore + real gitSync (gitFixture) + real claudeRunner pointed at fake-claude; or stubs where noted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorker, processJob } from '../src/worker.js';
import { createJobStore } from '../src/jobStore.js';
import { createGitSync, GitSyncError } from '../src/gitSync.js';
import { createClaudeRunner } from '../src/claudeRunner.js';
import { createGitFixture, FAKE_CLAUDE } from '../test-support/gitFixture.js';

const silent = { info() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const okOutcome = (result = 'done') => ({
  outcome: 'succeeded', result, error: null,
  meta: { session_id: 's', total_cost_usd: 0, num_turns: 1, duration_ms: 1, subtype: 'success', is_error: false },
});

function realDeps(fx, over = {}) {
  const store = createJobStore();
  const gitSync = createGitSync({ repoUrl: fx.originUrl, workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
  const claudeRunner = createClaudeRunner({
    claudeBin: FAKE_CLAUDE, permissionMode: 'bypassPermissions', maxTurns: 5, timeoutMs: 10_000, killGraceMs: 200, ...over,
  });
  return { store, gitSync, claudeRunner, workspaceDir: fx.workspaceDir, logger: silent };
}

test('T3: statuses observed in order queued -> pulling -> running -> succeeded; result + commit set', async () => {
  const store = createJobStore();
  const gitD = deferred();
  const claudeD = deferred();
  let claudeArgs;
  const deps = {
    store,
    gitSync: { sync: () => gitD.promise },
    claudeRunner: { run: (a) => { claudeArgs = a; return claudeD.promise; } },
    workspaceDir: '/ws',
    logger: silent,
  };
  const worker = createWorker(deps);
  const job = store.create({ prompt: 'say hello', branch: 'dev' });
  worker.enqueue(job.id);
  assert.equal(job.status, 'queued');
  assert.equal(worker.queueLength(), 1);
  await tick(); await tick();
  assert.equal(job.status, 'pulling');
  assert.equal(worker.currentJobId(), job.id);
  assert.ok(job.started_at);
  gitD.resolve({ commit: 'abc1234' });
  await tick(); await tick();
  assert.equal(job.status, 'running');
  assert.equal(job.commit, 'abc1234');
  assert.equal(claudeArgs.prompt, 'say hello');
  assert.equal(claudeArgs.cwd, '/ws');
  claudeD.resolve(okOutcome('hello!'));
  await worker.onIdle();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result, 'hello!');
  assert.equal(job.error, null);
  assert.ok(job.finished_at);
  assert.equal(job.claude.subtype, 'success');
  assert.equal(worker.currentJobId(), null);
  assert.match(store.toPublic(job).logs_tail, /queued -> pulling\n\[job\] pulling -> running\n\[job\] running -> succeeded/);
});

test('T11: 3 jobs enqueued back to back all queued immediately, run strictly one at a time, FIFO order, all succeed', async () => {
  const store = createJobStore();
  let active = 0;
  let maxActive = 0;
  const order = [];
  const deps = {
    store,
    gitSync: { sync: async () => ({ commit: 'c0ffee1' }) },
    claudeRunner: {
      run: async ({ prompt }) => {
        active++; maxActive = Math.max(maxActive, active); order.push(prompt);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return okOutcome(prompt);
      },
    },
    workspaceDir: '/ws',
    logger: silent,
  };
  const worker = createWorker(deps);
  const jobs = ['one', 'two', 'three'].map((p) => store.create({ prompt: p, branch: 'main' }));
  for (const j of jobs) worker.enqueue(j.id);
  assert.deepEqual(jobs.map((j) => j.status), ['queued', 'queued', 'queued']);
  await worker.onIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.deepEqual(jobs.map((j) => j.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(jobs.map((j) => j.result), ['one', 'two', 'three']);
});

test('T11 (real git + fake claude): 3 sequential jobs against one workspace, no git conflicts', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx);
    const worker = createWorker(deps);
    const jobs = ['a', 'b', 'c'].map((p) => deps.store.create({ prompt: `${p} [[fake:junk]]`, branch: p === 'b' ? 'dev' : 'main' }));
    for (const j of jobs) worker.enqueue(j.id);
    await worker.onIdle();
    for (const j of jobs) {
      assert.equal(j.status, 'succeeded', j.error ?? '');
      assert.ok(fx.head(j.branch).startsWith(j.commit));
    }
  } finally { fx.cleanup(); }
});

test('T9: git failure -> job failed with "git clone failed: ..."; next job still runs', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx);
    deps.gitSync = createGitSync({ repoUrl: path.join(fx.root, 'missing.git'), workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
    const worker = createWorker(deps);
    const bad = deps.store.create({ prompt: 'p', branch: 'main' });
    worker.enqueue(bad.id);
    await worker.onIdle();
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /^git clone failed: /);
    assert.match(deps.store.toPublic(bad).logs_tail, /\[git\] \$ git clone/);
    assert.equal(bad.commit, null);

    // worker still alive; fix the repo URL and the next job succeeds
    deps.gitSync = createGitSync({ repoUrl: fx.originUrl, workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
    const worker2 = createWorker(deps);
    const good = deps.store.create({ prompt: 'hi', branch: 'main' });
    worker.enqueue(bad.id); // re-enqueue of a terminal job is skipped harmlessly
    worker2.enqueue(good.id);
    await Promise.all([worker.onIdle(), worker2.onIdle()]);
    assert.equal(bad.status, 'failed');
    assert.equal(good.status, 'succeeded');
  } finally { fx.cleanup(); }
});

test('T9: claude failure ([[fake:error]]) -> failed, error + logs_tail populated', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx);
    const worker = createWorker(deps);
    const j = deps.store.create({ prompt: 'run tests [[fake:error]]', branch: 'main' });
    const k = deps.store.create({ prompt: 'after', branch: 'main' });
    worker.enqueue(j.id);
    worker.enqueue(k.id);
    await worker.onIdle();
    assert.equal(j.status, 'failed');
    assert.match(j.error, /^claude reported an error \(error_during_execution\): fake failure: e2e tests failed/);
    assert.equal(j.result, 'fake failure: e2e tests failed');
    assert.equal(j.claude.is_error, true);
    const tail = deps.store.toPublic(j).logs_tail;
    assert.match(tail, /\[claude\] exit=1 subtype=error_during_execution/);
    assert.match(tail, /\[job\] running -> failed/);
    assert.equal(k.status, 'succeeded');
  } finally { fx.cleanup(); }
});

test('T9: gitSync throwing a non-GitSyncError / store bug -> job failed "Internal error: ..."; loop continues', async () => {
  const store = createJobStore();
  let n = 0;
  const deps = {
    store,
    gitSync: {
      sync: async () => {
        n++;
        if (n === 1) throw new TypeError('oops not a git error');
        if (n === 2) throw new GitSyncError('fetch', 'remote gone');
        return { commit: 'abc' };
      },
    },
    claudeRunner: {
      run: async ({ prompt }) => {
        if (prompt === 'explode') throw new Error('runner bug');
        return okOutcome();
      },
    },
    workspaceDir: '/ws',
    logger: silent,
  };
  const worker = createWorker(deps);
  const jobs = ['a', 'b', 'explode', 'd'].map((p) => store.create({ prompt: p, branch: 'main' }));
  for (const j of jobs) worker.enqueue(j.id);
  await worker.onIdle();
  assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[0].error, 'Internal error: oops not a git error');
  assert.equal(jobs[1].error, 'git fetch failed: remote gone');
  assert.equal(jobs[2].status, 'failed');
  assert.equal(jobs[2].error, 'Internal error: runner bug');
  assert.equal(jobs[3].status, 'succeeded');

  // processJob never throws, even for an unknown id
  await processJob(deps, 'job_unknown');
});

test('T10: claude timeout -> job status "timeout", finished_at set, next job runs', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx, { timeoutMs: 500 });
    const worker = createWorker(deps);
    const slow = deps.store.create({ prompt: 'long task [[fake:sleep=30]]', branch: 'main' });
    const next = deps.store.create({ prompt: 'quick', branch: 'main' });
    const t0 = Date.now();
    worker.enqueue(slow.id);
    worker.enqueue(next.id);
    await worker.onIdle();
    assert.ok(Date.now() - t0 < 8000);
    assert.equal(slow.status, 'timeout');
    assert.equal(slow.error, 'Timed out after 0.5s; claude process killed');
    assert.ok(slow.finished_at);
    assert.equal(next.status, 'succeeded');
  } finally { fx.cleanup(); }
});

test('T12: job 1 [[fake:junk]] then job 2 [[fake:cat=junk.txt]] -> job 2 failed (file gone); README pristine', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx);
    const worker = createWorker(deps);
    const j1 = deps.store.create({ prompt: '[[fake:junk]]', branch: 'main' });
    const j2 = deps.store.create({ prompt: '[[fake:cat=junk.txt]]', branch: 'main' });
    const j3 = deps.store.create({ prompt: '[[fake:cat=README.md]]', branch: 'main' });
    for (const j of [j1, j2, j3]) worker.enqueue(j.id);
    await worker.onIdle();
    assert.equal(j1.status, 'succeeded');
    assert.equal(j2.status, 'failed');
    assert.match(j2.error, /no such file: junk\.txt/);
    assert.equal(j3.status, 'succeeded');
    assert.equal(j3.result, 'main\n');
    assert.equal(fs.existsSync(path.join(fx.workspaceDir, 'junkdir')), false);
    assert.equal(fs.existsSync(path.join(fx.workspaceDir, 'node_modules', 'keep.txt')), true);
  } finally { fx.cleanup(); }
});

test('shutdown(): queued jobs failed, running job aborted, onIdle resolves; enqueue after shutdown fails job', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx, { timeoutMs: 60_000 });
    const worker = createWorker(deps);
    const running = deps.store.create({ prompt: '[[fake:sleep=30]]', branch: 'main' });
    const queued = deps.store.create({ prompt: 'never runs', branch: 'main' });
    worker.enqueue(running.id);
    worker.enqueue(queued.id);
    const end = Date.now() + 10_000;
    while (running.status !== 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(running.status, 'running');
    await new Promise((r) => setTimeout(r, 200)); // let the fake spawn its grandchild

    const t0 = Date.now();
    await worker.shutdown('Service shutting down (test)');
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(running.status, 'failed');
    assert.equal(running.error, 'Aborted: service shutting down');
    assert.equal(queued.status, 'failed');
    assert.equal(queued.error, 'Service shutting down (test)');
    assert.equal(worker.queueLength(), 0);
    assert.equal(worker.currentJobId(), null);
    await worker.onIdle();

    const late = deps.store.create({ prompt: 'late', branch: 'main' });
    worker.enqueue(late.id);
    assert.equal(late.status, 'failed');
    assert.equal(late.error, 'Service shutting down (test)');
  } finally { fx.cleanup(); }
});

test('shutdown while pulling -> job failed "Service shutting down"', async () => {
  const store = createJobStore();
  const deps = {
    store,
    gitSync: {
      sync: (_b, _log, signal) => new Promise((_res, rej) => {
        signal.addEventListener('abort', () => rej(new GitSyncError('fetch', 'aborted')));
      }),
    },
    claudeRunner: { run: async () => okOutcome() },
    workspaceDir: '/ws',
    logger: silent,
  };
  const worker = createWorker(deps);
  const j = store.create({ prompt: 'p', branch: 'main' });
  worker.enqueue(j.id);
  await tick(); await tick();
  assert.equal(j.status, 'pulling');
  await worker.shutdown();
  assert.equal(j.status, 'failed');
  assert.equal(j.error, 'Service shutting down');
});
