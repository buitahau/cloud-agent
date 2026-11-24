// src/claudeRunner.js
// Run `claude -p` headless inside the workspace, enforce the job timeout, parse the JSON result.
// Covers T3/T5/T7/T8 (happy path), T9 (failure), T10 (timeout kill).

import { runProcess } from './lib/processRunner.js';

/** Env vars removed from the child env (see buildClaudeEnv). */
export const STRIPPED_ENV_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',      // would silently switch billing from the subscription to the API
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',             // set when the service itself is launched from a Claude Code session; makes
  'CLAUDE_CODE_ENTRYPOINT', //   the child think it's nested
]);

/**
 * Parsed `--output-format json` payload (only the fields we use; claude emits many more).
 * Verified against claude 2.1.x: a single JSON object on stdout with type === "result".
 * NOTE: an auth failure exits 1 with subtype "success" but is_error: true — so ALWAYS check is_error.
 * @typedef {Object} ClaudeJsonResult
 * @property {'result'} type
 * @property {string}   subtype         "success" | "error_max_turns" | "error_during_execution" | ...
 * @property {boolean}  is_error
 * @property {string}   [result]        final assistant text (may be absent on some error subtypes)
 * @property {string}   [session_id]
 * @property {number}   [total_cost_usd]
 * @property {number}   [num_turns]
 * @property {number}   [duration_ms]
 */

/**
 * @typedef {Object} ClaudeOutcome
 * @property {'succeeded'|'failed'|'timeout'} outcome
 * @property {string|null} result     parsed.result if parsed (even on failure), else null
 * @property {string|null} error      null iff outcome === 'succeeded'
 * @property {import('./jobStore.js').ClaudeMeta|null} meta   null if output unparseable
 */

/**
 * @typedef {Object} ClaudeRunnerOptions
 * @property {string}      claudeBin
 * @property {string}      permissionMode
 * @property {number}      maxTurns
 * @property {number}      timeoutMs              JOB_TIMEOUT_SECONDS * 1000; applies to the claude step only
 * @property {string|null} [oauthToken]           exported to the child as CLAUDE_CODE_OAUTH_TOKEN when set
 * @property {number}      [killGraceMs]          passed to run (tests use small values)
 * @property {import('./lib/processRunner.js').RunFn} [run=runProcess]
 * @property {NodeJS.ProcessEnv} [baseEnv=process.env]
 */

/**
 * @typedef {Object} ClaudeRunner
 * @property {(p: { prompt: string, cwd: string, log?: (line: string) => void, signal?: AbortSignal }) => Promise<ClaudeOutcome>} run
 *           Never rejects.
 */

/**
 * Factory.
 *
 * run({ prompt, cwd, log, signal }):
 *  1. log("[claude] $ <claudeBin> <args joined by space>")  (prompt is NOT in args; see buildClaudeArgs)
 *  2. r = await run({ cmd: claudeBin, args: buildClaudeArgs(...), cwd, env: buildClaudeEnv(...),
 *                     stdin: prompt, timeoutMs, killGraceMs, signal, lineStdout: false,
 *                     onLine: (l, s) => s === 'stderr' && log(`[claude:stderr] ${l}`) })
 *  3. parsed = parseClaudeJson(r.stdout)
 *  4. if !parsed && r.stdout.trim(): log last 20 lines of r.stdout prefixed "[claude:stdout] "
 *  5. log summary: "[claude] exit=<code|signal> subtype=<..> turns=<..> cost_usd=<..> duration_ms=<..>"
 *  6. return classifyClaudeRun(r, parsed, timeoutMs)
 *
 * @param {ClaudeRunnerOptions} opts
 * @returns {ClaudeRunner}
 */
export function createClaudeRunner(opts) {
  const {
    claudeBin,
    permissionMode,
    maxTurns,
    timeoutMs,
    oauthToken = null,
    killGraceMs,
    run = runProcess,
    baseEnv = process.env,
  } = opts;
  const args = buildClaudeArgs({ permissionMode, maxTurns });

  return {
    async run({ prompt, cwd, log = () => {}, signal }) {
      const safeLog = (line) => { try { log(line); } catch { /* never throw from logging */ } };
      try {
        safeLog(`[claude] $ ${claudeBin} ${args.join(' ')}`);
        const r = await run({
          cmd: claudeBin,
          args,
          cwd,
          env: buildClaudeEnv(baseEnv, oauthToken),
          stdin: prompt,
          timeoutMs,
          killGraceMs,
          signal,
          lineStdout: false,
          onLine: (l, s) => { if (s === 'stderr') safeLog(`[claude:stderr] ${l}`); },
        });
        const parsed = parseClaudeJson(r.stdout);
        if (!parsed && r.stdout.trim()) {
          const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0).slice(-20);
          for (const l of lines) safeLog(`[claude:stdout] ${l}`);
        }
        const exit = r.code ?? r.signal ?? 'none';
        safeLog(
          `[claude] exit=${exit} subtype=${parsed?.subtype ?? '-'} turns=${parsed?.num_turns ?? '-'}`
          + ` cost_usd=${parsed?.total_cost_usd ?? '-'} duration_ms=${parsed?.duration_ms ?? r.durationMs}`,
        );
        return classifyClaudeRun(r, parsed, timeoutMs);
      } catch (err) {
        // `run` must never reject, but a buggy injected stub might; keep the contract.
        return { outcome: 'failed', result: null, error: `Internal error: ${err?.message ?? err}`, meta: null };
      }
    },
  };
}

/**
 * Argument vector. The prompt is delivered on STDIN (not argv): avoids argv size limits and prompts that
 * start with "-" being parsed as flags. `claude -p` reads the prompt from stdin when no positional is given.
 *
 * Exactly: ['-p', '--output-format', 'json', '--permission-mode', permissionMode, '--max-turns', String(maxTurns)]
 * (--max-turns is accepted by claude 2.x even though it's hidden from --help.)
 *
 * @param {{ permissionMode: string, maxTurns: number }} p
 * @returns {string[]}
 */
export function buildClaudeArgs(p) {
  return ['-p', '--output-format', 'json', '--permission-mode', p.permissionMode, '--max-turns', String(p.maxTurns)];
}

/**
 * Child env: copy of baseEnv minus STRIPPED_ENV_VARS; if oauthToken set, CLAUDE_CODE_OAUTH_TOKEN = oauthToken.
 * Never mutates baseEnv.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string|null|undefined} oauthToken
 * @returns {NodeJS.ProcessEnv}
 */
export function buildClaudeEnv(baseEnv, oauthToken) {
  const env = { ...baseEnv };
  for (const k of STRIPPED_ENV_VARS) delete env[k];
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}

/**
 * Parse claude's stdout. Strategy:
 *  1. JSON.parse(stdout.trim()) — the normal case (single object).
 *  2. Fallback: scan lines from the end; first line that starts with "{" and JSON.parses to an object with
 *     type === "result" wins (handles stray warnings printed before the JSON).
 *  3. Otherwise null. Also null if the parsed value isn't an object with type === "result" and a boolean is_error.
 * Never throws.
 * @param {string} stdout
 * @returns {ClaudeJsonResult|null}
 */
const isResult = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && v.type === 'result' && typeof v.is_error === 'boolean';

export function parseClaudeJson(stdout) {
  if (typeof stdout !== 'string') return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    if (isResult(v)) return v;
  } catch { /* fall through to line scan */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line);
      if (isResult(v)) return v;
    } catch { /* keep scanning */ }
  }
  return null;
}

/**
 * Decide the outcome. Order matters:
 *  1. r.timedOut                     -> 'timeout', error `Timed out after ${timeoutMs/1000}s; claude process killed`
 *  2. r.aborted                      -> 'failed',  error 'Aborted: service shutting down'
 *  3. r.spawnError                   -> 'failed',  error `Failed to start claude: ${r.spawnError.message}`
 *  4. parsed && !parsed.is_error && r.code === 0 -> 'succeeded', error null
 *  5. parsed (is_error or code != 0) -> 'failed',  error `claude reported an error (${parsed.subtype}): ${parsed.result ?? 'no result text'}`
 *                                                  (truncate to 2000 chars)
 *  6. !parsed                        -> 'failed',  error `claude exited with ${code|signal}; unparseable output: <last non-empty stderr line or 'no stderr'>`
 * result = parsed?.result ?? null in every case. meta = toMeta(parsed) (null if !parsed).
 *
 * @param {import('./lib/processRunner.js').RunResult} r
 * @param {ClaudeJsonResult|null} parsed
 * @param {number} timeoutMs
 * @returns {ClaudeOutcome}
 */
const MAX_ERROR_LENGTH = 2000;
const lastNonEmptyLine = (text) => {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
};

export function classifyClaudeRun(r, parsed, timeoutMs) {
  const result = parsed?.result ?? null;
  const meta = toMeta(parsed);
  const fail = (outcome, error) => ({ outcome, result, error, meta });

  if (r.timedOut) return fail('timeout', `Timed out after ${timeoutMs / 1000}s; claude process killed`);
  if (r.aborted) return fail('failed', 'Aborted: service shutting down');
  if (r.spawnError) return fail('failed', `Failed to start claude: ${r.spawnError.message}`);
  if (parsed && parsed.is_error === false && r.code === 0) return { outcome: 'succeeded', result, error: null, meta };
  if (parsed) {
    const msg = `claude reported an error (${parsed.subtype}): ${parsed.result ?? 'no result text'}`;
    return fail('failed', msg.length > MAX_ERROR_LENGTH ? msg.slice(0, MAX_ERROR_LENGTH) : msg);
  }
  return fail(
    'failed',
    `claude exited with ${r.code ?? r.signal}; unparseable output: ${lastNonEmptyLine(r.stderr) ?? 'no stderr'}`,
  );
}

/**
 * Pick ClaudeMeta fields from parsed output; missing fields -> null.
 * @param {ClaudeJsonResult|null} parsed
 * @returns {import('./jobStore.js').ClaudeMeta|null}
 */
export function toMeta(parsed) {
  if (!parsed) return null;
  const pick = (k) => (parsed[k] === undefined ? null : parsed[k]);
  return {
    session_id: pick('session_id'),
    total_cost_usd: pick('total_cost_usd'),
    num_turns: pick('num_turns'),
    duration_ms: pick('duration_ms'),
    subtype: pick('subtype'),
    is_error: pick('is_error'),
  };
}
