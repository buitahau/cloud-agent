// Covers: T3, T5, T6, T7, T8 against the REAL claude CLI and a REAL target repo. Opt-in: E2E=1 (npm run test:e2e).
// Reads the project's .env (dotenv) + REPOS_FILE for the target repo and its token; the service imports repos.json +
// GIT_TOKEN_* into a temp DB (DB_FILE in a tmp dir; MASTER_KEY from .env or random). Costs subscription usage. T7/T8 assertions are
// heuristic (result text mentions the agent/skill) — confirm manually via logs_tail as well.
//
// How it runs: spawns `node src/index.js` with cwd = project root (so dotenv loads the real .env), PORT=0,
// then drives it over HTTP exactly like a caller would.
//
// Optional knobs (env):
//   E2E_REPO=<id>                    repo id from REPOS_FILE to test against (default: the first repo)
//   E2E_BRANCHES=main,dev            branches for T6 (both must exist on origin)
//   E2E_MARKER_CONTENT=<text>        T5: expected content of MARKER.txt on the repo's defaultBranch (push it first). If unset,
//                                    T5 only checks that `commit` equals `git ls-remote` HEAD of that branch.
//   E2E_T7_EXPECT=<regex>            T7: regex the result must match (default /test|pass|fail/i)
//   E2E_T8_PROMPT=<prompt>           T8: prompt that triggers a repo skill / slash command (T8 skipped if unset)
//   E2E_T8_EXPECT=<regex>            T8: regex matched against result + logs_tail
//   E2E_JOB_WAIT_SECONDS=1800        max wait per job
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = process.env.E2E === '1' ? false : 'set E2E=1 to run against real claude';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB_WAIT_MS = Number(process.env.E2E_JOB_WAIT_SECONDS || 1800) * 1000;
const T = { skip: SKIP, timeout: JOB_WAIT_MS + 60_000 };

/** @type {import('node:child_process').ChildProcess|null} */
let service = null;
let base = '';
let apiKey = '';
let config = null;
/** @type {import('../src/repoImport.js').ImportRepo|null} */
let repo = null;
let serviceLog = '';
let tmp = '';

before(async () => {
  if (SKIP) return;
  const dotenv = await import('dotenv');
  const parsed = dotenv.config({ path: path.join(ROOT, '.env') }).parsed ?? {};
  const env = { ...parsed, ...process.env };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const serviceEnv = {
    ...process.env,
    PORT: '0',
    DB_FILE: path.join(tmp, 'cloud-agent.db'),
    MASTER_KEY: env.MASTER_KEY?.trim() || crypto.randomBytes(32).toString('base64'),
  };
  const { loadConfig } = await import('../src/config.js');
  const { loadReposFile } = await import('../src/repoImport.js');
  config = loadConfig({ ...env, ...serviceEnv }, { cwd: ROOT });
  apiKey = config.apiKey;
  const f = loadReposFile(config.reposFile, env, { cwd: ROOT, allowLocal: config.allowLocalRepos, sshKeysDir: config.sshKeysDir });
  if (!f.found || f.problems.length) {
    throw new Error(`cannot use ${config.reposFile}:\n  - ${f.found ? f.problems.join('\n  - ') : 'file not found'}`);
  }
  repo = process.env.E2E_REPO ? f.repos.find((r) => r.id === process.env.E2E_REPO) ?? null : f.repos[0] ?? null;
  if (!repo) throw new Error(`E2E_REPO "${process.env.E2E_REPO ?? ''}" is not in ${config.reposFile}`);

  service = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: serviceEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout.setEncoding('utf8').on('data', (c) => { serviceLog += c; });
  service.stderr.setEncoding('utf8').on('data', (c) => { serviceLog += c; });
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const m = /Listening on :(\d+)/.exec(serviceLog);
    if (m) { base = `http://127.0.0.1:${m[1]}`; return; }
    if (service.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`service did not start:\n${serviceLog}`);
});

after(async () => {
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await new Promise((r) => { service.on('close', r); setTimeout(r, 15_000); });
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function submit(body) {
  const res = await fetch(`${base}/${repo.id}/run-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 202);
  const json = await res.json();
  assert.equal(json.status, 'queued');
  return json.id;
}

/** Poll every 2s until terminal; returns { job, seen } where seen = distinct statuses in order. */
async function waitJob(id) {
  const seen = [];
  const end = Date.now() + JOB_WAIT_MS;
  while (Date.now() < end) {
    const res = await fetch(`${base}/${repo.id}/run-agent/${id}`, { headers: { 'x-api-key': apiKey } });
    assert.equal(res.status, 200);
    const job = await res.json();
    if (seen[seen.length - 1] !== job.status) seen.push(job.status);
    if (['succeeded', 'failed', 'timeout'].includes(job.status)) return { job, seen };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`job ${id} did not finish within ${JOB_WAIT_MS}ms`);
}

const explain = (job) => `status=${job.status} error=${job.error}\nlogs_tail:\n${job.logs_tail}`;

async function remoteHead(branch) {
  const { buildGitEnv } = await import('../src/gitSync.js');
  const { runProcess } = await import('../src/lib/processRunner.js');
  const r = await runProcess({
    cmd: 'git',
    args: ['ls-remote', '--', repo.url, `refs/heads/${branch}`],
    env: buildGitEnv({ baseEnv: process.env, repoUrl: repo.url, sshKeyPath: repo.sshKeyPath, token: repo.token }),
    timeoutMs: 60_000,
  });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.split(/\s+/)[0];
}

test('T3: "say hello" job reaches succeeded with non-empty result', T, async () => {
  const id = await submit({ prompt: 'say hello' });
  const { job, seen } = await waitJob(id);
  assert.equal(job.status, 'succeeded', explain(job));
  assert.ok(job.result && job.result.trim().length > 0);
  assert.ok(job.commit);
  assert.equal(seen[seen.length - 1], 'succeeded');
  // Polling every 2s may miss short phases, but order must be preserved.
  const order = ['queued', 'pulling', 'running', 'succeeded'];
  const idx = seen.map((s) => order.indexOf(s));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `status order ${seen.join(' -> ')}`);
});

test('T5: push MARKER.txt to the repo\'s default branch (manual precondition), prompt asks for its content -> result contains it', T, async () => {
  const head = await remoteHead(repo.defaultBranch);
  const id = await submit({ prompt: 'What is the content of MARKER.txt? Reply with the content only.' });
  const { job } = await waitJob(id);
  assert.equal(job.status, 'succeeded', explain(job));
  assert.ok(head.startsWith(job.commit), `commit ${job.commit} != origin ${head}`);
  if (process.env.E2E_MARKER_CONTENT) assert.ok(job.result.includes(process.env.E2E_MARKER_CONTENT.trim()), job.result);
});

test('T6: branch:"main" and branch:"dev" jobs report matching branch and commit', T, async () => {
  const branches = (process.env.E2E_BRANCHES || 'main,dev').split(',').map((b) => b.trim()).filter(Boolean);
  for (const branch of branches) {
    const head = await remoteHead(branch);
    const id = await submit({ prompt: 'Reply with exactly: OK', branch });
    const { job } = await waitJob(id);
    assert.equal(job.status, 'succeeded', explain(job));
    assert.equal(job.branch, branch);
    assert.ok(head.startsWith(job.commit), `${branch}: commit ${job.commit} != origin ${head}`);
  }
});

test('T7: "Please use test agent to test e2e test suite of feature A" -> succeeded, result summarizes pass/fail', T, async () => {
  const id = await submit({ prompt: 'Please use test agent to test e2e test suite of feature A' });
  const { job } = await waitJob(id);
  assert.equal(job.status, 'succeeded', explain(job));
  const expect = new RegExp(process.env.E2E_T7_EXPECT || 'test|pass|fail', 'i');
  assert.match(job.result, expect);
  console.log(`[T7] result:\n${job.result}\n[T7] logs_tail:\n${job.logs_tail}`);
});

test('T8: prompt triggering a repo skill/slash command -> visible in result/logs_tail',
  { ...T, skip: SKIP || (process.env.E2E_T8_PROMPT ? false : 'set E2E_T8_PROMPT (and E2E_T8_EXPECT) to run T8') },
  async () => {
    const id = await submit({ prompt: process.env.E2E_T8_PROMPT });
    const { job } = await waitJob(id);
    assert.equal(job.status, 'succeeded', explain(job));
    if (process.env.E2E_T8_EXPECT) {
      assert.match(`${job.result}\n${job.logs_tail}`, new RegExp(process.env.E2E_T8_EXPECT, 'i'));
    }
    console.log(`[T8] result:\n${job.result}`);
  });
