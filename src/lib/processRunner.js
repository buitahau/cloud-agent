// src/lib/processRunner.js
// The ONLY place that spawns child processes. gitSync, claudeRunner and claudeAuth all receive
// a `run` function with this signature via dependency injection, so tests can either
//   (a) pass the real runProcess and point the binary at test-support/fake-claude.js, or
//   (b) pass a stub `run` that returns canned RunResult objects.

import { spawn } from 'node:child_process';
import { LineSplitter } from './logBuffer.js';

/** Default cap on captured stdout/stderr (bytes each). Excess is dropped; `truncated` flag set. */
export const DEFAULT_MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
/** Default delay between SIGTERM and SIGKILL when killing a process group. */
export const DEFAULT_KILL_GRACE_MS = 5000;
/** After SIGKILL, if 'close' still hasn't fired after this long, resolve anyway (destroy stdio). */
export const POST_KILL_RESOLVE_MS = 2000;

/**
 * @typedef {Object} RunOptions
 * @property {string}   cmd                 executable (no shell; never use shell:true)
 * @property {string[]} args
 * @property {string}   [cwd]
 * @property {NodeJS.ProcessEnv} [env]      full env for the child (caller builds it; default process.env)
 * @property {string}   [stdin]             written to child stdin then stdin is ended. If undefined, stdin is
 *                                          ended immediately (child sees EOF; never leave stdin open — claude -p
 *                                          waits on an open stdin).
 * @property {number}   [timeoutMs]         0/undefined = no timeout. On expiry: kill process GROUP, timedOut=true.
 * @property {number}   [killGraceMs]       default DEFAULT_KILL_GRACE_MS
 * @property {AbortSignal} [signal]         abort -> kill process group the same way as a timeout, aborted=true
 * @property {(line: string, stream: 'stdout'|'stderr') => void} [onLine]  called per complete line (and the
 *                                          final partial line at exit). Exceptions thrown by onLine are swallowed.
 * @property {boolean}  [lineStdout=true]   if false, stdout is captured but not passed to onLine (claude's
 *                                          JSON blob is one huge line; we don't want it line-logged)
 * @property {number}   [maxCaptureBytes]   default DEFAULT_MAX_CAPTURE_BYTES
 */

/**
 * @typedef {Object} RunResult
 * @property {number|null}  code        exit code (null if killed by signal or failed to spawn)
 * @property {string|null}  signal      terminating signal name, if any
 * @property {string}       stdout      captured (possibly truncated) utf8
 * @property {string}       stderr      captured (possibly truncated) utf8
 * @property {boolean}      timedOut
 * @property {boolean}      aborted
 * @property {boolean}      truncated   true if stdout or stderr hit maxCaptureBytes
 * @property {Error|null}   spawnError  e.g. ENOENT when the binary doesn't exist
 * @property {number}       durationMs
 */

/**
 * @callback RunFn
 * @param {RunOptions} opts
 * @returns {Promise<RunResult>}
 */

/**
 * Spawn a process and collect its output. NEVER rejects: every failure is expressed in RunResult.
 *
 * Process-tree kill design (T10):
 *  - spawn with { detached: true, stdio: ['pipe','pipe','pipe'] } so the child leads a NEW process group
 *    (pgid === child.pid). claude spawns subprocesses (bash tools, test runners, subagents); they inherit
 *    the group.
 *  - To kill: killGroup(child.pid, 'SIGTERM'); after killGraceMs, killGroup(child.pid, 'SIGKILL') if not
 *    yet exited. killGroup = process.kill(-pid, sig) wrapped in try/catch (ESRCH = already gone).
 *  - Do NOT call child.unref(); we want to wait for it.
 *  - Resolve on the child's 'close' event (all stdio closed). Safety net: if 'close' hasn't fired
 *    POST_KILL_RESOLVE_MS after SIGKILL, destroy the stdio streams and resolve with what we have.
 *  - Handle 'error' event (spawn failure, e.g. ENOENT): resolve with spawnError set, code null.
 *    Guard against resolving twice ('error' and 'close' may both fire).
 *  - Clear all timers on exit.
 *
 * Output capture:
 *  - Decode with setEncoding('utf8') on both streams.
 *  - Append to stdout/stderr strings until maxCaptureBytes (approximate via string length is fine),
 *    then stop appending and set truncated=true.
 *  - Feed stderr (always) and stdout (if lineStdout) into a LineSplitter per stream -> onLine.
 *    flush() both splitters on close.
 *
 * @type {RunFn}
 */
export async function runProcess(opts) {
  const {
    cmd,
    args = [],
    cwd,
    env = process.env,
    stdin,
    timeoutMs = 0,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    signal,
    onLine,
    lineStdout = true,
    maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
  } = opts;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exited = false;
    /** @type {NodeJS.Timeout|null} */ let timeoutTimer = null;
    /** @type {NodeJS.Timeout|null} */ let killTimer = null;
    /** @type {NodeJS.Timeout|null} */ let resolveTimer = null;
    /** @type {import('node:child_process').ChildProcess|null} */ let child = null;

    const safeLine = (line, stream) => {
      if (!onLine) return;
      try { onLine(line, stream); } catch { /* swallowed by contract */ }
    };
    const outSplitter = new LineSplitter((l) => safeLine(l, 'stdout'));
    const errSplitter = new LineSplitter((l) => safeLine(l, 'stderr'));

    const clearTimers = () => {
      for (const t of [timeoutTimer, killTimer, resolveTimer]) if (t) clearTimeout(t);
      timeoutTimer = killTimer = resolveTimer = null;
    };
    const onAbort = () => startKill('abort');

    const finish = (code, sig, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (signal) signal.removeEventListener('abort', onAbort);
      try { outSplitter.flush(); } catch { /* ignore */ }
      try { errSplitter.flush(); } catch { /* ignore */ }
      resolve({
        code: spawnError ? null : code,
        signal: sig ?? null,
        stdout,
        stderr,
        timedOut,
        aborted,
        truncated,
        spawnError,
        durationMs: Date.now() - started,
      });
    };

    let killing = false;
    function startKill(reason) {
      if (killing || settled || !child || child.pid === undefined) return;
      killing = true;
      if (reason === 'timeout') timedOut = true; else aborted = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killGroup(/** @type {number} */ (child?.pid), 'SIGKILL');
        resolveTimer = setTimeout(() => {
          // Safety net: something (e.g. an escaped grandchild) holds stdio open.
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish(child?.exitCode ?? null, child?.signalCode ?? 'SIGKILL');
        }, POST_KILL_RESOLVE_MS);
      }, killGraceMs);
    }

    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish(null, null, /** @type {Error} */ (err));
      return;
    }

    child.on('error', (err) => {
      // Spawn failure (ENOENT, EACCES...). If the process already exited this is some other error; ignore.
      if (!exited) finish(null, null, err);
    });

    const capture = (which, chunk) => {
      const cur = which === 'stdout' ? stdout : stderr;
      if (cur.length >= maxCaptureBytes) { truncated = true; return; }
      let add = chunk;
      if (cur.length + add.length > maxCaptureBytes) {
        add = add.slice(0, maxCaptureBytes - cur.length);
        truncated = true;
      }
      if (which === 'stdout') stdout += add; else stderr += add;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      capture('stdout', chunk);
      if (lineStdout) outSplitter.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      capture('stderr', chunk);
      errSplitter.write(chunk);
    });
    // Avoid EPIPE crashes if the child exits before reading stdin.
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.on('exit', () => {
      exited = true;
      // The leader is gone; if we were killing, make sure the rest of the group is gone too.
      if (killing && child?.pid !== undefined) killGroup(child.pid, 'SIGKILL');
    });
    child.on('close', (code, sig) => finish(code, sig));

    if (child.stdin) {
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    }

    if (timeoutMs && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => startKill('timeout'), timeoutMs);
    }
    if (signal) {
      if (signal.aborted) startKill('abort');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Send a signal to an entire process group. Never throws.
 * @param {number} pid   group leader pid (child.pid of a detached spawn)
 * @param {NodeJS.Signals} sig
 */
export function killGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, sig); } catch { /* ESRCH etc. */ }
}
