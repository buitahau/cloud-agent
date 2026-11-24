// test-support/gitFixture.js — throwaway "origin" repos for gitSync/worker tests. COMPLETE (not a stub).
// Lives outside test/ (Node 18 `node --test test/` would execute it as a test file).
//
// Layout created under a fresh mkdtemp dir:
//   <root>/origin.git   bare repo (REPO_URL for tests; plain path works as a git URL)
//   <root>/seed         working clone used to push commits to origin
//   <root>/workspace    NOT created — this is the WORKSPACE_DIR the code under test should clone into
// Branches: "main" (README.md "main\n") and "dev" (README.md "dev\n").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 */
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * @typedef {Object} GitFixture
 * @property {string} root
 * @property {string} originUrl      path to the bare repo (use as repoUrl)
 * @property {string} workspaceDir   absolute, does not exist yet
 * @property {(branch: string, file: string, content: string, message?: string) => string} commit
 *           write file on branch in the seed clone, commit, push to origin; returns the new FULL sha.
 *           Assert with `fullSha.startsWith(job.commit)` — short-sha length can differ between clones.
 * @property {(branch: string) => string} head   FULL sha of origin/<branch>
 * @property {() => void} cleanup
 */

/** @returns {GitFixture} */
export function createGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-git-'));
  const originUrl = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const workspaceDir = path.join(root, 'workspace');

  git(['init', '--bare', '--initial-branch=main', originUrl], root);
  git(['init', '--initial-branch=main', seed], root);
  git(['remote', 'add', 'origin', originUrl], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'main\n');
  git(['add', '-A'], seed);
  git(['commit', '-m', 'init main'], seed);
  git(['push', 'origin', 'main'], seed);
  git(['checkout', '-b', 'dev'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'dev\n');
  git(['commit', '-am', 'init dev'], seed);
  git(['push', 'origin', 'dev'], seed);

  const commit = (branch, file, content, message = `update ${file}`) => {
    git(['checkout', branch], seed);
    const p = path.join(seed, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    git(['add', '-A'], seed);
    git(['commit', '-m', message], seed);
    git(['push', 'origin', branch], seed);
    return git(['rev-parse', 'HEAD'], seed);
  };
  const head = (branch) => git(['rev-parse', `refs/heads/${branch}`], originUrl);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });

  return { root, originUrl, workspaceDir, commit, head, cleanup };
}

/** Absolute path to the fake claude binary. */
export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
