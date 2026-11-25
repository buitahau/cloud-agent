// Covers: job record shape (spec §5) and status transitions (spec §6). Supports T2, T3, T9, T10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore, TRANSITIONS, IllegalTransitionError, JobNotFoundError } from '../src/jobStore.js';

function clock() {
  let t = Date.parse('2026-11-25T10:00:00.000Z');
  return () => { const d = new Date(t); t += 1000; return d; };
}

test('create -> status queued, id /^job_[0-9a-f]{32}$/, created_at ISO, nullable fields null', () => {
  const store = createJobStore();
  const job = store.create({ prompt: 'p', branch: 'dev' });
  assert.match(job.id, /^job_[0-9a-f]{32}$/);
  assert.equal(job.status, 'queued');
  assert.equal(job.prompt, 'p');
  assert.equal(job.branch, 'dev');
  assert.equal(new Date(job.created_at).toISOString(), job.created_at);
  for (const k of ['commit', 'started_at', 'finished_at', 'result', 'error', 'claude']) assert.equal(job[k], null, k);
  assert.equal(store.get(job.id), job);
  assert.notEqual(store.create({ prompt: 'q', branch: 'main' }).id, job.id);
  assert.equal(store.list().length, 2);
});

test('toPublic returns exactly the spec keys (+ logs_tail, claude) in order', () => {
  const store = createJobStore();
  const pub = store.toPublic(store.create({ prompt: 'p', branch: 'main' }));
  assert.deepEqual(Object.keys(pub),
    ['id', 'status', 'prompt', 'branch', 'commit', 'created_at', 'started_at', 'finished_at', 'result', 'error', 'logs_tail', 'claude']);
  assert.equal(pub.logs_tail, '');
  assert.equal(pub.claude, null);
  assert.doesNotThrow(() => JSON.stringify(pub));
});

test('happy path queued->pulling->running->succeeded sets started_at then finished_at (injected now())', () => {
  const store = createJobStore({ now: clock(), genId: () => 'job_fixed' });
  const job = store.create({ prompt: 'p', branch: 'main' });
  assert.equal(job.created_at, '2026-11-25T10:00:00.000Z');
  store.transition(job.id, 'pulling');
  assert.equal(job.started_at, '2026-11-25T10:00:01.000Z');
  assert.equal(job.finished_at, null);
  store.update(job.id, { commit: 'abc1234' });
  store.transition(job.id, 'running');
  const meta = { session_id: 's', total_cost_usd: 0.1, num_turns: 2, duration_ms: 9, subtype: 'success', is_error: false };
  store.transition(job.id, 'succeeded', { result: 'done', error: null, claude: meta });
  assert.equal(job.finished_at, '2026-11-25T10:00:02.000Z');
  const pub = store.toPublic(job);
  assert.equal(pub.status, 'succeeded');
  assert.equal(pub.commit, 'abc1234');
  assert.equal(pub.result, 'done');
  assert.deepEqual(pub.claude, meta);
  assert.equal(pub.logs_tail, '[job] queued -> pulling\n[job] pulling -> running\n[job] running -> succeeded');
});

test('pulling->failed and running->timeout allowed; terminal states reject any transition', () => {
  const store = createJobStore();
  const a = store.create({ prompt: 'a', branch: 'main' });
  store.transition(a.id, 'pulling');
  store.transition(a.id, 'failed', { error: 'git clone failed: x' });
  assert.equal(a.error, 'git clone failed: x');
  assert.ok(a.finished_at);

  const b = store.create({ prompt: 'b', branch: 'main' });
  store.transition(b.id, 'pulling');
  store.transition(b.id, 'running');
  store.transition(b.id, 'timeout', { error: 'Timed out' });
  assert.equal(b.status, 'timeout');

  for (const job of [a, b]) {
    for (const to of Object.keys(TRANSITIONS)) {
      assert.throws(() => store.transition(job.id, /** @type {any} */ (to)), IllegalTransitionError);
    }
  }
});

test('illegal transitions (queued->running, succeeded->running) throw IllegalTransitionError', () => {
  const store = createJobStore();
  const j = store.create({ prompt: 'p', branch: 'main' });
  assert.throws(() => store.transition(j.id, 'running'), IllegalTransitionError);
  assert.equal(j.status, 'queued');
  store.transition(j.id, 'pulling');
  store.transition(j.id, 'running');
  store.transition(j.id, 'succeeded');
  assert.throws(() => store.transition(j.id, 'running'), (err) => {
    assert.ok(err instanceof IllegalTransitionError);
    assert.equal(err.from, 'succeeded');
    assert.equal(err.to, 'running');
    return true;
  });
});

test('unknown id: get -> undefined; transition/update throw JobNotFoundError; appendLog is a no-op', () => {
  const store = createJobStore();
  assert.equal(store.get('nope'), undefined);
  assert.throws(() => store.transition('nope', 'pulling'), JobNotFoundError);
  assert.throws(() => store.update('nope', { commit: 'x' }), JobNotFoundError);
  assert.doesNotThrow(() => store.appendLog('nope', 'line'));
});

test('update rejects `status` and unknown keys', () => {
  const store = createJobStore();
  const j = store.create({ prompt: 'p', branch: 'main' });
  assert.throws(() => store.update(j.id, /** @type {any} */ ({ status: 'succeeded' })));
  assert.throws(() => store.update(j.id, /** @type {any} */ ({ prompt: 'x' })));
  assert.equal(j.status, 'queued');
  assert.equal(j.prompt, 'p');
  store.update(j.id, { commit: 'c', result: 'r' });
  assert.equal(j.commit, 'c');
  assert.equal(j.result, 'r');
});

test('logs_tail returns the last logsTailLines lines', () => {
  const store = createJobStore({ logsTailLines: 3, logCapacity: 10 });
  const j = store.create({ prompt: 'p', branch: 'main' });
  for (let i = 1; i <= 20; i++) store.appendLog(j.id, `line ${i}`);
  assert.equal(store.toPublic(j).logs_tail, 'line 18\nline 19\nline 20');
  assert.equal(j.log.size, 10);
});

test('events: monotonic seq, status + terminal result events, replay via readEvents, bounded ring with dropped count', () => {
  const store = createJobStore({ eventCapacity: 4 });
  const job = store.create({ prompt: 'p', branch: 'b' });
  const seen = [];
  const unsub = store.subscribe(job.id, (e) => seen.push(e.type));
  store.transition(job.id, 'pulling');
  store.appendLog(job.id, 'hello');
  store.appendEvent(job.id, 'assistant_text', { text: 'hi' });
  assert.deepEqual(seen, ['status', 'log', 'assistant_text']);
  unsub();
  store.transition(job.id, 'running');
  assert.equal(seen.length, 3); // unsubscribed

  // capacity 4: 4 events so far (status, log, assistant_text, status) -> add terminal (status+result) evicts 2
  store.transition(job.id, 'succeeded', { result: 'done' });
  const all = store.readEvents(job.id, 0);
  assert.deepEqual(all.events.map((e) => e.seq), [3, 4, 5, 6]);
  assert.equal(all.dropped, 2);
  assert.equal(all.events.at(-1).type, 'result');
  assert.equal(all.events.at(-1).data.result, 'done');
  const later = store.readEvents(job.id, 4);
  assert.deepEqual(later.events.map((e) => e.seq), [5, 6]);
  assert.equal(later.dropped, 0);
  assert.equal(store.readEvents('nope'), null);
  assert.equal(store.subscribe('nope', () => {}), null);
  assert.equal(store.appendEvent('nope', 'x'), null);
  // a throwing subscriber never breaks the store
  const j2 = store.create({ prompt: 'p', branch: 'b' });
  store.subscribe(j2.id, () => { throw new Error('bad subscriber'); });
  assert.doesNotThrow(() => store.appendEvent(j2.id, 'log', {}));
  // events are internal: not in the public shape
  assert.ok(!('events' in store.toPublic(job)));
});
