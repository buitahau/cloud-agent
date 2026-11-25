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

test('SSE events: a real job through worker + fake claude emits status, claude events and a terminal result', async () => {
  const fx = createGitFixture();
  try {
    const deps = realDeps(fx);
    const worker = createWorker(deps);
    const job = deps.store.create({ prompt: '[[fake:success]] go', branch: fx.branch ?? 'main' });
    worker.enqueue(job.id);
    await tick();
    await worker.onIdle();
    const { events } = deps.store.readEvents(job.id, 0);
    const types = events.map((e) => e.type);
    for (const t of ['status', 'log', 'init', 'thinking', 'assistant_text', 'tool_use', 'tool_result', 'result']) {
      assert.ok(types.includes(t), `missing ${t} in ${types.join(',')}`);
    }
    assert.equal(types.at(-1), 'result');
    assert.equal(events.at(-1).data.status, 'succeeded');
    assert.equal(job.status, 'succeeded');
  } finally {
    fx.cleanup?.();
  }
});

// ---- multi-repo scheduling --------------------------------------------------------------------------------

/** Stub repos whose sync() resolves immediately and a claude runner that waits until released per prompt. */
function multiRepoDeps(repoIds, maxConcurrent) {
  const store = createJobStore();
  const gates = new Map();
  const started = [];
  let active = 0;
  let maxActive = 0;
  const repos = new Map(repoIds.map((id) => [id, { gitSync: { sync: async () => ({ commit: id }) }, workspaceDir: `/ws/${id}` }]));
  const claudeRunner = {
    run: ({ prompt, cwd, signal }) => {
      active++; maxActive = Math.max(maxActive, active);
      started.push({ prompt, cwd });
      const d = deferred();
      gates.set(prompt, d);
      signal?.addEventListener('abort', () => d.resolve({ outcome: 'failed', result: null, error: 'aborted', meta: null }));
      return d.promise.finally(() => { active--; });
    },
  };
  const worker = createWorker({ store, repos, claudeRunner, maxConcurrent, logger: silent });
  const submit = (repoId, prompt) => { const j = store.create({ prompt, branch: 'main', repoId }); worker.enqueue(j.id); return j; };
  const release = (prompt) => gates.get(prompt).resolve(okOutcome(prompt));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  return { store, worker, submit, release, settle, started, maxActive: () => maxActive };
}

test('multi-repo: two repos with maxConcurrent=2 run in parallel, each in its own workspace', async () => {
  const m = multiRepoDeps(['web', 'api'], 2);
  const a = m.submit('web', 'a');
  const b = m.submit('api', 'b');
  await m.settle();
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.deepEqual(m.started.map((s) => s.cwd).sort(), ['/ws/api', '/ws/web']);
  assert.deepEqual(m.worker.stats().running.map((r) => r.repoId).sort(), ['api', 'web']);
  m.release('a'); m.release('b');
  await m.worker.onIdle();
  assert.equal(m.maxActive(), 2);
  assert.equal(a.commit, 'web');
  assert.equal(b.commit, 'api');
});

test('multi-repo: same repo never runs two jobs at once, even with maxConcurrent=2', async () => {
  const m = multiRepoDeps(['web'], 2);
  const a = m.submit('web', 'a');
  const b = m.submit('web', 'b');
  await m.settle();
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'queued');
  assert.equal(m.worker.queueLength('web'), 1);
  m.release('a');
  await m.settle();
  assert.equal(b.status, 'running');
  m.release('b');
  await m.worker.onIdle();
  assert.equal(m.maxActive(), 1);
});

test('multi-repo: A1, A2, B1 with maxConcurrent=2 -> A1 and B1 together, A2 waits for A1 (skip-ahead keeps per-repo FIFO)', async () => {
  const m = multiRepoDeps(['a', 'b'], 2);
  const a1 = m.submit('a', 'a1');
  const a2 = m.submit('a', 'a2');
  const b1 = m.submit('b', 'b1');
  await m.settle();
  assert.deepEqual([a1.status, a2.status, b1.status], ['running', 'queued', 'running']);
  m.release('b1');
  await m.settle();
  assert.equal(a2.status, 'queued'); // repo a still busy
  m.release('a1');
  await m.settle();
  assert.equal(a2.status, 'running');
  m.release('a2');
  await m.worker.onIdle();
  assert.deepEqual(m.started.map((s) => s.prompt), ['a1', 'b1', 'a2']);
});

test('multi-repo: maxConcurrent=1 across repos is strict FIFO, one at a time', async () => {
  const m = multiRepoDeps(['a', 'b'], 1);
  const jobs = [m.submit('a', 'x'), m.submit('b', 'y'), m.submit('a', 'z')];
  for (const p of ['x', 'y', 'z']) {
    await m.settle();
    assert.deepEqual(jobs.map((j) => j.status).filter((s) => s === 'running').length, 1);
    m.release(p);
  }
  await m.worker.onIdle();
  assert.deepEqual(m.started.map((s) => s.prompt), ['x', 'y', 'z']);
  assert.equal(m.maxActive(), 1);
});

test('multi-repo: shutdown aborts every running job and fails queued ones', async () => {
  const m = multiRepoDeps(['a', 'b'], 2);
  const a = m.submit('a', 'a');
  const b = m.submit('b', 'b');
  const q = m.submit('a', 'q');
  await m.settle();
  await m.worker.shutdown('bye');
  assert.equal(a.status, 'failed');
  assert.equal(b.status, 'failed');
  assert.equal(q.status, 'failed');
  assert.equal(q.error, 'bye');
  assert.deepEqual(m.worker.runningJobIds(), []);
});

test('multi-repo: job for an unknown repo fails without blocking others', async () => {
  const m = multiRepoDeps(['a'], 1);
  const bad = m.submit('ghost', 'g');
  const good = m.submit('a', 'ok');
  await m.settle();
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error, 'unknown repo "ghost"');
  assert.equal(good.status, 'running');
  m.release('ok');
  await m.worker.onIdle();
  assert.equal(good.status, 'succeeded');
});

test('multi-repo (real git + fake claude): each job runs in its own repo workspace', async () => {
  const fa = createGitFixture();
  const fb = createGitFixture();
  try {
    fa.commit('main', 'WHO.txt', 'repo-a\n');
    fb.commit('main', 'WHO.txt', 'repo-b\n');
    const store = createJobStore();
    const claudeRunner = createClaudeRunner({ claudeBin: FAKE_CLAUDE, permissionMode: 'bypassPermissions', maxTurns: 5, timeoutMs: 10_000, killGraceMs: 200 });
    const repos = new Map([
      ['a', { gitSync: createGitSync({ repoUrl: fa.originUrl, workspaceDir: fa.workspaceDir, timeoutMs: 30_000 }), workspaceDir: fa.workspaceDir }],
      ['b', { gitSync: createGitSync({ repoUrl: fb.originUrl, workspaceDir: fb.workspaceDir, timeoutMs: 30_000 }), workspaceDir: fb.workspaceDir }],
    ]);
    const worker = createWorker({ store, repos, claudeRunner, maxConcurrent: 2, logger: silent });
    const ja = store.create({ prompt: '[[fake:cat=WHO.txt]]', branch: 'main', repoId: 'a' });
    const jb = store.create({ prompt: '[[fake:cat=WHO.txt]]', branch: 'main', repoId: 'b' });
    worker.enqueue(ja.id);
    worker.enqueue(jb.id);
    await worker.onIdle();
    assert.equal(ja.status, 'succeeded', ja.error);
    assert.equal(jb.status, 'succeeded', jb.error);
    assert.match(ja.result, /repo-a/);
    assert.match(jb.result, /repo-b/);
  } finally { fa.cleanup(); fb.cleanup(); }
});
