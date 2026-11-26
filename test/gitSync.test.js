// Covers: T5 (pulls latest), T6 (branch selection), T12 (clean workspace), T9 (bad URL -> GitSyncError).
// Real git against local bare repos from test-support/gitFixture.js. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGitSync, buildGitEnv, normalizeRemote, GitSyncError } from '../src/gitSync.js';
import { createGitFixture, git } from '../test-support/gitFixture.js';

function setup(over = {}) {
  const fx = createGitFixture();
  const gs = createGitSync({ repoUrl: fx.originUrl, workspaceDir: fx.workspaceDir, timeoutMs: 30_000, ...over });
  return { fx, gs };
}
const read = (fx, f) => fs.readFileSync(path.join(fx.workspaceDir, f), 'utf8');
const rejectsStep = (p, step) => assert.rejects(p, (err) => {
  assert.ok(err instanceof GitSyncError, String(err));
  assert.equal(err.step, step);
  assert.match(err.message, new RegExp(`^git ${step} failed: `));
  return true;
});

test('first sync clones into a non-existent workspaceDir and returns short commit of origin/main', async () => {
  const { fx, gs } = setup();
  try {
    assert.equal(fs.existsSync(fx.workspaceDir), false);
    const { commit } = await gs.sync('main');
    assert.match(commit, /^[0-9a-f]{4,40}$/);
    assert.ok(fx.head('main').startsWith(commit));
    assert.equal(read(fx, 'README.md'), 'main\n');
  } finally { fx.cleanup(); }
});

test('T5: new commit pushed to origin is picked up on next sync (MARKER.txt present, commit matches)', async () => {
  const { fx, gs } = setup();
  try {
    const first = await gs.sync('dev');
    const sha = fx.commit('dev', 'MARKER.txt', 'marker-42\n');
    const { commit } = await gs.sync('dev');
    assert.notEqual(commit, first.commit);
    assert.ok(sha.startsWith(commit));
    assert.equal(read(fx, 'MARKER.txt'), 'marker-42\n');
  } finally { fx.cleanup(); }
});

test('T6: sync("dev") then sync("main") then sync("dev") — README content and commit match each branch', async () => {
  const { fx, gs } = setup();
  try {
    for (const b of ['dev', 'main', 'dev']) {
      const { commit } = await gs.sync(b);
      assert.ok(fx.head(b).startsWith(commit), b);
      assert.equal(read(fx, 'README.md'), `${b}\n`);
      assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.workspaceDir), b);
    }
  } finally { fx.cleanup(); }
});

test('T6: branch that exists only on origin (created after clone) can be synced', async () => {
  const { fx, gs } = setup();
  try {
    await gs.sync('main');
    const sha = fx.commit('main', 'x.txt', 'x');
    git(['push', 'origin', `${sha}:refs/heads/feature/new`], path.join(fx.root, 'seed'));
    const { commit } = await gs.sync('feature/new');
    assert.ok(sha.startsWith(commit));
    assert.equal(read(fx, 'x.txt'), 'x');
  } finally { fx.cleanup(); }
});

test('T12: untracked files, ignored files, modified tracked files are removed; node_modules/ is kept', async () => {
  const { fx, gs } = setup();
  try {
    fx.commit('main', '.gitignore', 'ignored.log\n');
    await gs.sync('main');
    const ws = fx.workspaceDir;
    fs.writeFileSync(path.join(ws, 'junk.txt'), 'junk');
    fs.mkdirSync(path.join(ws, 'junkdir'));
    fs.writeFileSync(path.join(ws, 'junkdir', 'a.txt'), 'a');
    fs.writeFileSync(path.join(ws, 'ignored.log'), 'log');
    fs.appendFileSync(path.join(ws, 'README.md'), 'dirty\n');
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.writeFileSync(path.join(ws, 'node_modules', 'keep.txt'), 'keep');
    git(['add', 'junk.txt'], ws); // staged changes are dropped too
    await gs.sync('main');
    assert.equal(fs.existsSync(path.join(ws, 'junk.txt')), false);
    assert.equal(fs.existsSync(path.join(ws, 'junkdir')), false);
    assert.equal(fs.existsSync(path.join(ws, 'ignored.log')), false);
    assert.equal(read(fx, 'README.md'), 'main\n');
    assert.equal(read(fx, 'node_modules/keep.txt'), 'keep');
    assert.equal(git(['status', '--porcelain'], ws), '?? node_modules/'); // only the kept dir
  } finally { fx.cleanup(); }
});

test('T9: bad repoUrl -> GitSyncError step "clone"; workspaceDir removed so a later good sync can clone', async () => {
  const fx = createGitFixture();
  try {
    const bad = createGitSync({ repoUrl: path.join(fx.root, 'nope.git'), workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
    await rejectsStep(bad.sync('main'), 'clone');
    assert.equal(fs.existsSync(fx.workspaceDir), false);
    const good = createGitSync({ repoUrl: fx.originUrl, workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
    const { commit } = await good.sync('main');
    assert.ok(fx.head('main').startsWith(commit));
  } finally { fx.cleanup(); }
});

test('T9: unknown branch -> GitSyncError step "fetch"', async () => {
  const { fx, gs } = setup();
  try {
    await rejectsStep(gs.sync('does-not-exist'), 'fetch');
  } finally { fx.cleanup(); }
});

test('invalid branch name -> GitSyncError step "validate" without running git (stub run never called)', async () => {
  let calls = 0;
  const gs = createGitSync({ repoUrl: '/x', workspaceDir: '/tmp/never-used-ws', timeoutMs: 1000, run: async () => { calls++; throw new Error('no'); } });
  for (const b of ['-rf', 'a..b', '']) await rejectsStep(gs.sync(b), 'validate');
  assert.equal(calls, 0);
});

test('workspaceDir exists, non-empty, not a repo -> GitSyncError step "clone"', async () => {
  const { fx, gs } = setup();
  try {
    fs.mkdirSync(fx.workspaceDir);
    fs.writeFileSync(path.join(fx.workspaceDir, 'stuff.txt'), 'x');
    await assert.rejects(gs.sync('main'), /git clone failed: workspace exists and is not a git repo/);
    assert.equal(fs.existsSync(path.join(fx.workspaceDir, 'stuff.txt')), true); // untouched
  } finally { fx.cleanup(); }
});

test('git command timeout -> GitSyncError with "timed out after Ns"', async () => {
  const stubRun = async () => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, aborted: false, truncated: false, spawnError: null, durationMs: 2000 });
  const { fx } = setup();
  try {
    const gs = createGitSync({ repoUrl: fx.originUrl, workspaceDir: fx.workspaceDir, timeoutMs: 2000, run: stubRun });
    await rejectsStep(gs.sync('main'), 'clone');
    await assert.rejects(gs.sync('main'), /git clone failed: timed out after 2s/);
  } finally { fx.cleanup(); }
});

test('log callback receives "[git] $ git ..." lines', async () => {
  const { fx, gs } = setup();
  try {
    const lines = [];
    await gs.sync('main', (l) => lines.push(l));
    const cmds = lines.filter((l) => l.startsWith('[git] $ '));
    assert.deepEqual(cmds, [
      `[git] $ git clone --no-checkout -- ${fx.originUrl} ${fx.workspaceDir}`,
      '[git] $ git fetch --prune origin +refs/heads/main:refs/remotes/origin/main',
      '[git] $ git checkout -f -B main origin/main',
      '[git] $ git reset --hard origin/main',
      '[git] $ git clean -fdx -e node_modules',
      '[git] $ git rev-parse --short HEAD',
    ]);
    assert.ok(lines.some((l) => l.startsWith('[git] ') && !l.startsWith('[git] $ ')), 'git output lines logged');
  } finally { fx.cleanup(); }
});

test('buildGitEnv: GIT_TERMINAL_PROMPT=0; ssh key -> GIT_SSH_COMMAND; https+token -> GIT_CONFIG_* header; token never in argv', async () => {
  const base = { PATH: '/bin' };
  const plain = buildGitEnv({ baseEnv: base, repoUrl: 'git@github.com:o/r.git' });
  assert.deepEqual(plain, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file', GIT_TRACE_REDACT: '1' });
  assert.deepEqual(base, { PATH: '/bin' });

  const ssh = buildGitEnv({ baseEnv: base, repoUrl: 'git@github.com:o/r.git', sshKeyPath: '/home/u/.ssh/id', token: 'tok' });
  assert.equal(ssh.GIT_SSH_COMMAND, "ssh -i '/home/u/.ssh/id' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
  assert.equal(ssh.GIT_CONFIG_COUNT, undefined); // token only applies to https URLs
  assert.throws(() => buildGitEnv({ baseEnv: base, repoUrl: 'x', sshKeyPath: "/a'b" }), GitSyncError);

  const https = buildGitEnv({ baseEnv: base, repoUrl: 'https://github.com/o/r.git', token: 'ghp_secret' });
  assert.equal(https.GIT_CONFIG_COUNT, '1');
  assert.equal(https.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader'); // token only sent to the repo's own host
  assert.equal(https.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`);

  // token is passed via env only, never argv
  const calls = [];
  const stub = async (o) => {
    calls.push(o);
    return { code: 1, signal: null, stdout: '', stderr: 'fatal: nope\n', timedOut: false, aborted: false, truncated: false, spawnError: null, durationMs: 1 };
  };
  const gs = createGitSync({
    repoUrl: 'https://github.com/o/r.git', token: 'ghp_secret', workspaceDir: '/tmp/cloud-agent-never-exists-xyz/ws', timeoutMs: 1000, run: stub,
    baseEnv: { PATH: '/bin', API_KEY: 'k', MY_PAT: 'x' }, secretEnvNames: ['MY_PAT'],
  });
  await assert.rejects(gs.sync('main'), /git clone failed: fatal: nope/);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.join(' ').includes('ghp_secret'));
  assert.equal(calls[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(calls[0].env.GIT_CONFIG_VALUE_0.startsWith('Authorization: Basic '));
  assert.equal(calls[0].env.API_KEY, undefined);
  assert.equal(calls[0].env.MY_PAT, undefined);
  assert.equal(calls[0].env.GIT_TRACE_REDACT, '1');
  fs.rmSync('/tmp/cloud-agent-never-exists-xyz', { recursive: true, force: true });
});

test("buildGitEnv strips service secrets, keeps the repo's own header, forces GIT_TRACE_REDACT", () => {
  const base = {
    PATH: '/bin', API_KEY: 'k', ADMIN_PASSWORD: 'p', MASTER_KEY: 'm', MASTER_KEY_PREVIOUS: 'mp', GIT_TOKEN_WEB: 'w',
    MY_PAT: 'ghp_secret', GIT_TRACE_REDACT: '0', GIT_AUTHOR_NAME: 'a',
  };
  const snapshot = { ...base };
  const env = buildGitEnv({ baseEnv: base, repoUrl: 'https://github.com/o/r.git', token: 'ghp_secret', secretEnvNames: ['MY_PAT'] });
  for (const k of ['API_KEY', 'ADMIN_PASSWORD', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'GIT_TOKEN_WEB', 'MY_PAT']) {
    assert.equal(k in env, false, `${k} reached git`);
  }
  assert.equal(env.GIT_TRACE_REDACT, '1');
  assert.equal(env.GIT_AUTHOR_NAME, 'a');
  assert.ok(env.GIT_CONFIG_VALUE_0.startsWith('Authorization: Basic '));
  assert.deepEqual(base, snapshot);
});

test('two repos synced into two workspaces stay independent', async () => {
  const a = setup();
  const b = setup();
  try {
    a.fx.commit('main', 'A.txt', 'from a\n');
    b.fx.commit('main', 'B.txt', 'from b\n');
    await a.gs.sync('main');
    await b.gs.sync('main');
    assert.equal(read(a.fx, 'A.txt'), 'from a\n');
    assert.equal(read(b.fx, 'B.txt'), 'from b\n');
    assert.equal(fs.existsSync(path.join(a.fx.workspaceDir, 'B.txt')), false);
    assert.equal(fs.existsSync(path.join(b.fx.workspaceDir, 'A.txt')), false);
  } finally { a.fx.cleanup(); b.fx.cleanup(); }
});

test('workspace that is a clone of a different repo -> GitSyncError("validate"), nothing synced', async () => {
  const a = setup();
  const other = createGitFixture();
  try {
    await a.gs.sync('main');
    const wrong = createGitSync({ repoUrl: other.originUrl, workspaceDir: a.fx.workspaceDir, timeoutMs: 30_000 });
    await rejectsStep(wrong.sync('main'), 'validate');
    await assert.rejects(wrong.sync('main'), /different repo/);
    // same repo still syncs fine
    await a.gs.sync('dev');
    assert.equal(read(a.fx, 'README.md'), 'dev\n');
  } finally { a.fx.cleanup(); other.cleanup(); }
});

test('normalizeRemote ignores trailing ".git" / "/" and https host case', () => {
  assert.equal(normalizeRemote('https://GitHub.com/o/r.git'), normalizeRemote('https://github.com/o/r/'));
  assert.equal(normalizeRemote('git@github.com:o/r.git'), 'git@github.com:o/r');
  assert.notEqual(normalizeRemote('https://github.com/o/r'), normalizeRemote('https://github.com/o/r2'));
});

test('GIT_ALLOW_PROTOCOL blocks ext:: remotes even if one reached git', async () => {
  const fx = createGitFixture();
  try {
    const marker = path.join(fx.root, 'pwned');
    const gs = createGitSync({ repoUrl: `ext::sh -c touch% ${marker}`, workspaceDir: fx.workspaceDir, timeoutMs: 30_000 });
    await rejectsStep(gs.sync('main'), 'clone');
    assert.equal(fs.existsSync(marker), false);
  } finally { fx.cleanup(); }
});
