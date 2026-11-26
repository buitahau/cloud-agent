// src/claudeAuth.js
// Startup authentication check (spec §4 note, test T1). Fail fast if Claude can't authenticate.
//
// Auth model: the service uses the Claude subscription already logged in on this machine (`claude` → /login),
// stored in ~/.claude of the OS user running the service. No token is configured; token/API-key env vars are
// stripped (see buildClaudeEnv) so that login is always what claude uses. The service's own secrets (API_KEY,
// ADMIN_PASSWORD, MASTER_KEY*, git tokens) are stripped too.
//
// Why a probe too: `claude auth status --json` only checks that stored credentials exist, not that they still
// work (e.g. a revoked session). By default we also run a 1-turn probe (CLAUDE_AUTH_PROBE=true). A bad login
// makes the probe exit 1 with JSON { is_error: true, api_error_status: 401, result: "Failed to authenticate..." }.

import os from 'node:os';
import { runProcess } from './lib/processRunner.js';
import { buildClaudeEnv, parseClaudeJson } from './claudeRunner.js';

export const AUTH_PROBE_PROMPT = 'Reply with exactly: OK';
export const AUTH_STEP_TIMEOUT_MS = 90_000;

export class ClaudeAuthError extends Error {
  /**
   * @param {'binary'|'status'|'probe'} step
   * @param {string} message  must be actionable, e.g. include "log in with `claude` (/login) as this user"
   */
  constructor(step, message) {
    super(`Claude auth check failed at ${step}: ${message}`);
    this.name = 'ClaudeAuthError';
    this.step = step;
  }
}

/**
 * @typedef {Object} AuthCheckResult
 * @property {true}   ok
 * @property {string} version      `claude --version` stdout trimmed, e.g. "2.1.331 (Claude Code)"
 * @property {string} authMethod   from `auth status --json` (.authMethod), always "claude.ai" (subscription login)
 * @property {boolean} probed      whether the live probe ran
 */

/**
 * Steps (each via `run`, env = buildClaudeEnv(baseEnv, secretEnvNames), timeoutMs = AUTH_STEP_TIMEOUT_MS):
 *  1. binary:  `<claudeBin> --version`               spawnError/code!=0 -> ClaudeAuthError('binary', `cannot run ${claudeBin}: ...`)
 *  2. status:  `<claudeBin> auth status --json`      parse stdout JSON; require .loggedIn === true and .authMethod === "claude.ai"
 *                                                    (exit code is 1 when logged out) -> else ClaudeAuthError('status', ...)
 *  3. probe (only if opts.probe): `<claudeBin> -p --output-format json --max-turns 1`, stdin AUTH_PROBE_PROMPT,
 *     cwd = os.tmpdir() (so no repo .claude/ settings or hooks are loaded).
 *     parsed = parseClaudeJson(stdout); require r.code === 0 && parsed && parsed.is_error === false
 *     -> else ClaudeAuthError('probe', parsed?.result ?? last stderr line ?? `exit ${code}`)
 * Never log the token. Never include stdout of `auth status` in errors (it can contain email/org).
 *
 * @param {Object} opts
 * @param {string}      opts.claudeBin
 * @param {boolean}     [opts.probe=true]
 * @param {import('./lib/processRunner.js').RunFn} [opts.run=runProcess]
 * @param {NodeJS.ProcessEnv} [opts.baseEnv=process.env]
 * @param {string[]} [opts.secretEnvNames=[]]  repos' auth.tokenEnv names, hidden from claude
 * @returns {Promise<AuthCheckResult>}
 * @throws {ClaudeAuthError}
 */
const lastLine = (text) => {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
};

export async function checkClaudeAuth(opts) {
  const { claudeBin, probe = true, run = runProcess, baseEnv = process.env, secretEnvNames = [] } = opts;
  const env = buildClaudeEnv(baseEnv, secretEnvNames);
  const hint = 'log in to your Claude subscription on this machine: run `claude`, then /login, as the same OS user that runs this service';

  // 1. binary
  const v = await run({ cmd: claudeBin, args: ['--version'], env, timeoutMs: AUTH_STEP_TIMEOUT_MS });
  if (v.spawnError || v.timedOut || v.code !== 0) {
    const why = v.spawnError?.message ?? (v.timedOut ? 'timed out' : lastLine(v.stderr) ?? `exit ${v.code ?? v.signal}`);
    throw new ClaudeAuthError('binary', `cannot run ${claudeBin}: ${why} (is Claude Code installed? set CLAUDE_BIN)`);
  }
  const version = v.stdout.trim();

  // 2. status (stdout may contain email/org: never log or echo it)
  const s = await run({ cmd: claudeBin, args: ['auth', 'status', '--json'], env, timeoutMs: AUTH_STEP_TIMEOUT_MS });
  /** @type {any} */
  let status = null;
  try { status = JSON.parse(s.stdout.trim()); } catch { status = null; }
  if (s.spawnError || s.timedOut || !status || status.loggedIn !== true) {
    const why = s.spawnError ? s.spawnError.message
      : s.timedOut ? 'timed out'
        : !status ? `unparseable output (exit ${s.code ?? s.signal})`
          : 'not logged in';
    throw new ClaudeAuthError('status', `\`claude auth status\` reports ${why}; ${hint}`);
  }
  const authMethod = typeof status.authMethod === 'string' ? status.authMethod : 'unknown';
  if (authMethod !== 'claude.ai') {
    throw new ClaudeAuthError('status', `expected a Claude subscription login (claude.ai) but found "${authMethod}"; ${hint}`);
  }

  // 3. live probe
  if (probe) {
    const r = await run({
      cmd: claudeBin,
      args: ['-p', '--output-format', 'json', '--max-turns', '1'],
      cwd: os.tmpdir(),
      env,
      stdin: AUTH_PROBE_PROMPT,
      timeoutMs: AUTH_STEP_TIMEOUT_MS,
      lineStdout: false,
    });
    const parsed = parseClaudeJson(r.stdout);
    if (!(r.code === 0 && parsed && parsed.is_error === false)) {
      const why = parsed?.result ?? lastLine(r.stderr)
        ?? (r.spawnError?.message ?? (r.timedOut ? 'timed out' : `exit ${r.code ?? r.signal}`));
      throw new ClaudeAuthError('probe', `${why}; ${hint}`);
    }
  }

  return { ok: true, version, authMethod, probed: Boolean(probe) };
}
