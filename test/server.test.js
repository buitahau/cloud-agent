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
