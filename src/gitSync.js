// src/gitSync.js
// Bring WORKSPACE_DIR to a pristine checkout of origin/<branch> and report the short commit.
// Covers T5 (latest code), T6 (branch selection), T12 (clean workspace), T9 (bad URL -> failed).

import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './lib/processRunner.js';
import { isValidBranchName } from './lib/validate.js';

/**
 * Thrown for any git failure. `step` names the failing command so the job error is readable.
 */
export class GitSyncError extends Error {
  /**
   * @param {string} step  one of: "validate" | "clone" | "fetch" | "checkout" | "reset" | "clean" | "rev-parse"
   * @param {string} message  short human text, e.g. last non-empty stderr line of git
   * @param {{ code?: number|null, timedOut?: boolean }} [extra]
   */
  constructor(step, message, extra = {}) {
    super(`git ${step} failed: ${message}`);
    this.name = 'GitSyncError';
    this.step = step;
    Object.assign(this, extra);
  }
}

/**
 * @typedef {Object} GitSyncOptions
 * @property {string}      repoUrl
 * @property {string}      workspaceDir     absolute path
 * @property {string|null} [sshKeyPath]     absolute (already ~-expanded)
 * @property {string|null} [token]
 * @property {number}      timeoutMs        per git command
 * @property {string}      [gitBin='git']
 * @property {import('./lib/processRunner.js').RunFn} [run=runProcess]
 * @property {NodeJS.ProcessEnv} [baseEnv=process.env]
 */

/**
 * @typedef {Object} GitSync
 * @property {(branch: string, log?: (line: string) => void, signal?: AbortSignal) => Promise<{ commit: string }>} sync
 *           Rejects with GitSyncError on any failure. `signal` is forwarded to every run() call; if aborted,
 *           throw GitSyncError(<step>, 'aborted').
 */

/**
 * Factory. Exact command sequence for sync(branch) (all via `run`, no shell, cwd as noted):
 *
 *  0. if (!isValidBranchName(branch)) throw new GitSyncError('validate', 'invalid branch name')
 *  1. if !exists(path.join(workspaceDir, '.git')):
 *       - if workspaceDir exists and is non-empty -> GitSyncError('clone', 'WORKSPACE_DIR exists and is not a git repo')
 *       - mkdir -p path.dirname(workspaceDir)
 *       - git clone --no-checkout -- <repoUrl> <workspaceDir>          (cwd: dirname(workspaceDir))
 *       - on failure: fs.rmSync(workspaceDir, {recursive:true, force:true}) so the next job retries a clean clone
 *  2. git fetch --prune origin +refs/heads/<branch>:refs/remotes/origin/<branch>   (cwd: workspaceDir)
 *       explicit refspec so origin/<branch> exists even for branches not in the clone's default refspec
 *  3. git checkout -f -B <branch> origin/<branch>
 *       (equivalent to spec's `checkout -f` + works when the local branch doesn't exist yet)
 *  4. git reset --hard origin/<branch>
 *  5. git clean -fdx -e node_modules
 *  6. git rev-parse --short HEAD   -> stdout.trim() is the commit
 *
 * Every command: env = buildGitEnv(...), timeoutMs = opts.timeoutMs, signal = the sync() signal.
 * Log each command as "[git] $ git <args...>" (no redaction needed: the token is in env, never in args),
 * and pass every stdout/stderr line to log as "[git] <line>".
 * A command fails if spawnError || timedOut || code !== 0 -> throw GitSyncError(step, reason) where reason is
 * "timed out after Ns" | spawnError.message | last non-empty stderr line (fallback "exit code N").
 *
 * @param {GitSyncOptions} opts
 * @returns {GitSync}
 */
export function createGitSync(opts) {
  const {
    repoUrl,
    workspaceDir,
    sshKeyPath = null,
    token = null,
    timeoutMs,
    gitBin = 'git',
    run = runProcess,
    baseEnv = process.env,
  } = opts;

  return {
    async sync(branch, log = () => {}, signal) {
      const safeLog = (line) => { try { log(line); } catch { /* ignore */ } };
      if (!isValidBranchName(branch)) throw new GitSyncError('validate', 'invalid branch name');
      const env = buildGitEnv({ baseEnv, repoUrl, sshKeyPath, token });

      const git = async (step, args, cwd) => {
        if (signal?.aborted) throw new GitSyncError(step, 'aborted');
        safeLog(`[git] $ ${gitBin} ${args.join(' ')}`);
        const r = await run({
          cmd: gitBin,
          args,
          cwd,
          env,
          timeoutMs,
          signal,
          onLine: (line) => safeLog(`[git] ${line}`),
        });
        if (r.aborted) throw new GitSyncError(step, 'aborted', { code: r.code });
        if (r.spawnError || r.timedOut || r.code !== 0) {
          let reason;
          if (r.timedOut) reason = `timed out after ${Math.round(timeoutMs / 1000)}s`;
          else if (r.spawnError) reason = r.spawnError.message;
          else {
            const lines = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            reason = lines.length ? lines[lines.length - 1] : `exit code ${r.code ?? r.signal}`;
          }
          throw new GitSyncError(step, reason, { code: r.code, timedOut: r.timedOut });
        }
        return r;
      };

      // 1. clone on first run
      if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
        if (fs.existsSync(workspaceDir) && fs.readdirSync(workspaceDir).length > 0) {
          throw new GitSyncError('clone', 'WORKSPACE_DIR exists and is not a git repo');
        }
        const parent = path.dirname(workspaceDir);
        fs.mkdirSync(parent, { recursive: true });
        try {
          await git('clone', ['clone', '--no-checkout', '--', repoUrl, workspaceDir], parent);
        } catch (err) {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
          throw err;
        }
      }

      const ref = `origin/${branch}`;
      await git('fetch', ['fetch', '--prune', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], workspaceDir);
      await git('checkout', ['checkout', '-f', '-B', branch, ref], workspaceDir);
      await git('reset', ['reset', '--hard', ref], workspaceDir);
      await git('clean', ['clean', '-fdx', '-e', 'node_modules'], workspaceDir);
      const r = await git('rev-parse', ['rev-parse', '--short', 'HEAD'], workspaceDir);
      return { commit: r.stdout.trim() };
    },
  };
}

/**
 * Build the child env for git. Never mutates baseEnv. Secrets go in env, never in argv or .git/config.
 *
 *  - Always: GIT_TERMINAL_PROMPT=0 (never hang on a credential prompt).
 *  - If sshKeyPath: GIT_SSH_COMMAND = `ssh -i '<sshKeyPath>' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`
 *    (single-quote the path; reject/escape paths containing a single quote).
 *  - If token AND repoUrl starts with "https://": inject an auth header via git's env-config (git >= 2.31):
 *      GIT_CONFIG_COUNT=1
 *      GIT_CONFIG_KEY_0=http.extraHeader
 *      GIT_CONFIG_VALUE_0=`Authorization: Basic ${base64('x-access-token:' + token)}`
 *    (works for GitHub PATs and GitHub App tokens).
 *
 * @param {{ baseEnv: NodeJS.ProcessEnv, repoUrl: string, sshKeyPath?: string|null, token?: string|null }} p
 * @returns {NodeJS.ProcessEnv}
 */
export function buildGitEnv(p) {
  const env = { ...p.baseEnv, GIT_TERMINAL_PROMPT: '0' };
  if (p.sshKeyPath) {
    if (p.sshKeyPath.includes("'")) throw new GitSyncError('validate', 'GIT_SSH_KEY_PATH must not contain a single quote');
    env.GIT_SSH_COMMAND = `ssh -i '${p.sshKeyPath}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
  }
  if (p.token && typeof p.repoUrl === 'string' && p.repoUrl.startsWith('https://')) {
    const basic = Buffer.from(`x-access-token:${p.token}`, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}
