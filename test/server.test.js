// Covers: T2 (202 + id, fast, non-blocking), T4 (404), x-api-key auth, body validation, error shapes.
// Start with startServer(createApp(...), 0) and use global fetch. Stub worker = { enqueue: id => calls.push(id) }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp, startServer, apiKeyAuth } from '../src/server.js';
import { createJobStore } from '../src/jobStore.js';

const KEY = 'test-key';
const silent = { info() {}, warn() {}, error() {} };

async function withServer(fn, { worker } = {}) {
  const store = createJobStore();
  const calls = [];
  const w = worker ?? { enqueue: (id) => calls.push(id) };
  const app = createApp({ config: { repoBranch: 'dev', apiKey: KEY }, store, worker: w, logger: silent });
  const server = await startServer(app, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, calls });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}
const post = (base, body, headers = { 'x-api-key': KEY }) => fetch(`${base}/run-agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (base, p, headers = { 'x-api-key': KEY }) => fetch(`${base}${p}`, { headers });

test('T2: POST /run-agent {prompt} -> 202 {id, status:"queued"} (exact keys) in < 1s, enqueue called once', async () => {
  await withServer(async ({ base, calls }) => {
    const t0 = Date.now();
    const res = await post(base, { prompt: 'say hello' });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['id', 'status']);
    assert.equal(body.status, 'queued');
    assert.match(body.id, /^job_[0-9a-f]{32}$/);
    assert.deepEqual(calls, [body.id]);
  });

  // A worker whose enqueue kicks off a never-resolving job must not delay the response.
  const pending = [];
  const worker = { enqueue: (id) => { pending.push(new Promise(() => {})); void id; } };
  await withServer(async ({ base }) => {
    const t0 = Date.now();
    const res = await post(base, { prompt: 'long one' });
    assert.equal(res.status, 202);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(pending.length, 1);
  }, { worker });
});

test('T2: POST without branch -> job.branch = config.repoBranch; with branch -> that branch', async () => {
  await withServer(async ({ base, store }) => {
    const a = await (await post(base, { prompt: 'p' })).json();
    const b = await (await post(base, { prompt: 'p', branch: 'main' })).json();
    assert.equal(store.get(a.id).branch, 'dev');
    assert.equal(store.get(b.id).branch, 'main');
  });
});

test('GET /run-agent/:id -> 200 with all spec §5 fields', async () => {
  await withServer(async ({ base }) => {
    const { id } = await (await post(base, { prompt: '  keep spaces  ' })).json();
    const res = await get(base, `/run-agent/${id}`);
    assert.equal(res.status, 200);
    const job = await res.json();
    assert.deepEqual(Object.keys(job),
      ['id', 'status', 'prompt', 'branch', 'commit', 'created_at', 'started_at', 'finished_at', 'result', 'error', 'logs_tail', 'claude']);
    assert.equal(job.id, id);
    assert.equal(job.status, 'queued');
    assert.equal(job.prompt, '  keep spaces  ');
    assert.equal(job.branch, 'dev');
    assert.equal(job.commit, null);
    assert.equal(job.logs_tail, '');
  });
});

test('T4: GET /run-agent/does-not-exist -> 404 {error}', async () => {
  await withServer(async ({ base }) => {
    const res = await get(base, '/run-agent/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'job not found' });
  });
});

test('auth: missing or wrong x-api-key -> 401 on POST and GET; /health needs no key', async () => {
  await withServer(async ({ base, calls }) => {
    for (const headers of [{}, { 'x-api-key': 'wrong' }, { 'x-api-key': `${KEY}x` }]) {
      const p = await post(base, { prompt: 'p' }, headers);
      assert.equal(p.status, 401);
      assert.deepEqual(await p.json(), { error: 'unauthorized' });
      const g = await get(base, '/run-agent/anything', headers);
      assert.equal(g.status, 401);
      assert.deepEqual(await g.json(), { error: 'unauthorized' });
    }
    assert.equal(calls.length, 0);
    const h = await get(base, '/health', {});
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true });
    assert.equal(h.headers.get('x-powered-by'), null);
  });
});

test('validation: missing prompt -> 400; bad branch -> 400; invalid JSON -> 400 "invalid JSON body"', async () => {
  await withServer(async ({ base, calls }) => {
    let res = await post(base, {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'prompt is required and must be a non-empty string' });
    res = await post(base, { prompt: 'p', branch: '--upload-pack=x' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'branch is not a valid branch name' });
    res = await post(base, '{"prompt": ');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
    res = await post(base, []);
    assert.equal(res.status, 400);
    res = await post(base, JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 + 10) }));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'body too large' });
    assert.equal(calls.length, 0);
  });
});

test('unknown route -> 404 {error:"not found"}', async () => {
  await withServer(async ({ base }) => {
    const res = await get(base, '/nope', {});
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });
});

test('internal error -> 500 {error:"internal error"}', async () => {
  const worker = { enqueue: () => { throw new Error('kaboom'); } };
  await withServer(async ({ base }) => {
    const res = await post(base, { prompt: 'p' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  }, { worker });
});

test('apiKeyAuth works standalone', async () => {
  const app = express();
  app.use(apiKeyAuth('k'));
  app.get('/', (_q, r) => r.json({ ok: 1 }));
  const server = await startServer(app, 0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    assert.equal((await fetch(base, { headers: { 'x-api-key': 'k' } })).status, 200);
    assert.equal((await fetch(base)).status, 401);
  } finally { await new Promise((r) => server.close(r)); }
});

test('startServer rejects on EADDRINUSE', async () => {
  const app = express();
  const s1 = await startServer(app, 0, '127.0.0.1');
  try {
    await assert.rejects(startServer(app, s1.address().port, '127.0.0.1'), /EADDRINUSE/);
  } finally { await new Promise((r) => s1.close(r)); }
});

// ---- SSE: GET /run-agent/:id/events ----------------------------------------------------------------------

/** Read an SSE response to completion (or until `until(frames)` is true) and parse the frames. */
async function readSse(res, until) {
  const frames = [];
  const dec = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f = { raw };
      for (const l of raw.split('\n')) {
        if (l.startsWith('id: ')) f.id = Number(l.slice(4));
        else if (l.startsWith('event: ')) f.event = l.slice(7);
        else if (l.startsWith('data: ')) f.data = JSON.parse(l.slice(6));
      }
      frames.push(f);
    }
    if (until?.(frames)) { await reader.cancel(); break; }
  }
  return frames;
}

test('SSE: 401 without key, 404 unknown job', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await get(base, '/run-agent/job_x/events', {})).status, 401);
    const res = await get(base, '/run-agent/job_x/events');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'job not found' });
  });
});

test('SSE: finished job -> headers, full replay, stream ends after the result event; Last-Event-ID resumes', async () => {
  await withServer(async ({ base, store }) => {
    const job = store.create({ prompt: 'p', branch: 'b' });
    store.transition(job.id, 'pulling');
    store.appendEvent(job.id, 'assistant_text', { text: 'hi' });
    store.transition(job.id, 'running');
    store.transition(job.id, 'succeeded', { result: 'all done' });

    const res = await get(base, `/run-agent/${job.id}/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.match(res.headers.get('cache-control'), /no-cache/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const frames = (await readSse(res)).filter((f) => f.event); // drops the "retry:" preamble
    assert.deepEqual(frames.map((f) => f.event), ['status', 'assistant_text', 'status', 'status', 'result']);
    assert.deepEqual(frames.map((f) => f.id), [1, 2, 3, 4, 5]);
    assert.equal(frames.at(-1).data.result, 'all done');

    const resumed = await fetch(`${base}/run-agent/${job.id}/events`, { headers: { 'x-api-key': KEY, 'last-event-id': '3' } });
    const rf = (await readSse(resumed)).filter((f) => f.event);
    assert.deepEqual(rf.map((f) => f.id), [4, 5]);

    const viaQuery = await get(base, `/run-agent/${job.id}/events?since=4`);
    assert.deepEqual((await readSse(viaQuery)).filter((f) => f.event).map((f) => f.id), [5]);
  });
});

test('SSE: evicted history -> gap event (no id) before the replay', async () => {
  const store = createJobStore({ eventCapacity: 2 });
  const app = createApp({ config: { repoBranch: 'dev', apiKey: KEY }, store, worker: { enqueue() {} }, logger: silent });
  const server = await startServer(app, 0, '127.0.0.1');
  try {
    const job = store.create({ prompt: 'p', branch: 'b' });
    store.transition(job.id, 'pulling');
    store.transition(job.id, 'failed', { error: 'x' }); // status, status, result = 3 events -> ring keeps the last 2
    const res = await get(`http://127.0.0.1:${server.address().port}`, `/run-agent/${job.id}/events`);
    const frames = (await readSse(res)).filter((f) => f.event);
    assert.equal(frames[0].event, 'gap');
    assert.equal(frames[0].id, undefined);
    assert.deepEqual(frames[0].data, { dropped: 1 });
    assert.equal(frames.at(-1).event, 'result');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('SSE: live job -> events arrive as they happen, stream closes after the terminal result; heartbeat pings', async () => {
  const store = createJobStore();
  const app = createApp({ config: { repoBranch: 'dev', apiKey: KEY }, store, worker: { enqueue() {} }, logger: silent, sseHeartbeatMs: 30 });
  const server = await startServer(app, 0, '127.0.0.1');
  try {
    const job = store.create({ prompt: 'p', branch: 'b' });
    store.transition(job.id, 'pulling');
    const res = await get(`http://127.0.0.1:${server.address().port}`, `/run-agent/${job.id}/events`);
    const collected = readSse(res);
    await new Promise((r) => setTimeout(r, 120)); // >= several heartbeats while nothing happens
    store.transition(job.id, 'running');
    store.appendEvent(job.id, 'tool_use', { name: 'Bash' });
    store.transition(job.id, 'succeeded', { result: 'ok' });
    const frames = await collected;
    assert.ok(frames.some((f) => f.raw === ': ping'), 'expected at least one heartbeat comment');
    const evs = frames.filter((f) => f.event).map((f) => f.event);
    assert.deepEqual(evs, ['status', 'status', 'tool_use', 'status', 'result']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('SSE: client disconnect unsubscribes; closeStreams() ends open streams', async () => {
  const store = createJobStore();
  const app = createApp({ config: { repoBranch: 'dev', apiKey: KEY }, store, worker: { enqueue() {} }, logger: silent });
  const server = await startServer(app, 0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const job = store.create({ prompt: 'p', branch: 'b' });
    store.transition(job.id, 'pulling');
    const ac = new AbortController();
    const res = await fetch(`${base}/run-agent/${job.id}/events`, { headers: { 'x-api-key': KEY }, signal: ac.signal });
    const first = res.body.getReader();
    await first.read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    // after the disconnect an append must not throw and nobody is subscribed any more
    assert.doesNotThrow(() => store.appendEvent(job.id, 'log', {}));

    const res2 = await get(base, `/run-agent/${job.id}/events`);
    const done = readSse(res2);
    await new Promise((r) => setTimeout(r, 50));
    await app.closeStreams();
    const frames = await done; // resolves because the server ended the stream
    assert.ok(Array.isArray(frames)); // reaching here at all proves closeStreams() ended the response
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
