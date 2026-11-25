// Covers: JOBS_FILE persistence — append/load (last line wins), crash-truncated lines, atomic compaction,
// write errors never throw, and a store round trip where an interrupted job comes back as failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobPersistence } from '../src/jobPersistence.js';
import { createJobStore } from '../src/jobStore.js';

const silent = { warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-file-'));

test('missing file -> load() = []', () => {
  const dir = tmp();
  try {
    const p = createJobPersistence({ file: path.join(dir, 'nope', 'jobs.jsonl'), getSnapshots: () => [], logger: silent });
    assert.deepEqual(p.load(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('append then load: last line per id wins, creates parent dir, partial trailing line ignored', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'data', 'jobs.jsonl');
    const warnings = [];
    const p = createJobPersistence({ file, getSnapshots: () => [], logger: { warn: (m) => warnings.push(m), error() {} } });
    p.append({ id: 'job_a', status: 'queued' });
    p.append({ id: 'job_b', status: 'queued' });
    p.append({ id: 'job_a', status: 'succeeded' });
    fs.appendFileSync(file, '{"id":"job_c","stat'); // crash mid-write
    const recs = p.load();
    assert.deepEqual(recs.map((r) => [r.id, r.status]), [['job_b', 'queued'], ['job_a', 'succeeded']]);
    assert.equal(warnings.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compact rewrites atomically; auto-compacts past compactAfterLines', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'jobs.jsonl');
    let current = [{ id: 'job_a', status: 'succeeded' }];
    const p = createJobPersistence({ file, getSnapshots: () => current, compactAfterLines: 3, logger: silent });
    for (let i = 0; i < 3; i++) p.append({ id: 'job_a', status: 'running' });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
    p.append({ id: 'job_a', status: 'succeeded' }); // 4th line > 3 -> compacted to getSnapshots()
    assert.equal(fs.readFileSync(file, 'utf8'), '{"id":"job_a","status":"succeeded"}\n');
    assert.deepEqual(fs.readdirSync(dir), ['jobs.jsonl']); // no temp file left behind
    current = [];
    p.compact(current);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('write errors are logged, never thrown', () => {
  const dir = tmp();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x'); // a FILE where the parent dir should be
    const errors = [];
    const p = createJobPersistence({ file: path.join(blocker, 'jobs.jsonl'), getSnapshots: () => [], logger: { warn() {}, error: (m) => errors.push(m) } });
    assert.doesNotThrow(() => p.append({ id: 'job_a' }));
    assert.doesNotThrow(() => p.compact([]));
    assert.equal(errors.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('round trip through a store: finished job restored, running job becomes failed', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'jobs.jsonl');
    let store1;
    const p1 = createJobPersistence({ file, getSnapshots: () => store1.list().map((j) => store1.snapshot(j)), logger: silent });
    store1 = createJobStore({ onPersist: (s) => p1.append(s) });
    const done = store1.create({ prompt: 'p', branch: 'main', repoId: 'web' });
    store1.transition(done.id, 'pulling');
    store1.transition(done.id, 'running');
    store1.appendLog(done.id, 'some output');
    store1.transition(done.id, 'succeeded', { result: 'ok' });
    const mid = store1.create({ prompt: 'q', branch: 'dev', repoId: 'api' });
    store1.transition(mid.id, 'pulling');
    store1.transition(mid.id, 'running');
    // process dies here

    const p2 = createJobPersistence({ file, getSnapshots: () => [], logger: silent });
    const store2 = createJobStore();
    assert.deepEqual(store2.hydrate(p2.load()), { loaded: 2, interrupted: 1 });
    assert.equal(store2.get(done.id).result, 'ok');
    assert.ok(store2.readLog(done.id).includes('some output'));
    assert.equal(store2.get(mid.id).status, 'failed');
    assert.equal(store2.get(mid.id).error, 'Service restarted while job was running');
    assert.deepEqual(store2.query().jobs.map((j) => j.id), [mid.id, done.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
