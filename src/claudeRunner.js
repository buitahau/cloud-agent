// src/claudeRunner.js
// Run `claude -p` headless inside the workspace, enforce the job timeout, parse the JSON result.
// Output is `--output-format stream-json --verbose` (NDJSON): each line is mapped to a live event via onEvent
// (see toEvents) and the final `type: "result"` line is the same object `--output-format json` used to print.
// Covers T3/T5/T7/T8 (happy path), T9 (failure), T10 (timeout kill).

import { runProcess } from './lib/processRunner.js';
import { withoutSecrets } from './lib/secretEnv.js';

/** Env vars removed from the child env (see buildClaudeEnv). */
export const STRIPPED_ENV_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',      // would silently switch billing from the subscription to the API
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',             // set when the service itself is launched from a Claude Code session; makes
  'CLAUDE_CODE_ENTRYPOINT', //   the child think it's nested
  'CLAUDE_CODE_OAUTH_TOKEN', // would override the subscription login stored in ~/.claude on this machine
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
 * @property {number}      [killGraceMs]          passed to run (tests use small values)
 * @property {import('./lib/processRunner.js').RunFn} [run=runProcess]
 * @property {NodeJS.ProcessEnv} [baseEnv=process.env]
 * @property {string[]} [secretEnvNames=[]]   env var names to hide from claude (env vars holding a stored repo token)
 */

/**
 * @typedef {Object} ClaudeRunner
 * @property {(p: { prompt: string, cwd: string, log?: (line: string) => void,
 *                  onEvent?: (type: string, data: object) => void, signal?: AbortSignal }) => Promise<ClaudeOutcome>} run
 *           Never rejects.
 */

/**
 * Factory.
 *
 * run({ prompt, cwd, log, signal }):
 *  1. log("[claude] $ <claudeBin> <args joined by space>")  (prompt is NOT in args; see buildClaudeArgs)
 *  2. r = await run({ cmd: claudeBin, args: buildClaudeArgs(...), cwd, env: buildClaudeEnv(baseEnv, secretEnvNames),
 *                     stdin: prompt, timeoutMs, killGraceMs, signal, lineStdout: true,
 *                     onLine: stderr -> log(`[claude:stderr] ${l}`); stdout -> JSON.parse, onEvent(...toEvents) })
 *  3. parsed = the `result` line seen while streaming (immune to the capture cap) ?? parseClaudeJson(r.stdout)
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
    killGraceMs,
    run = runProcess,
    baseEnv = process.env,
    secretEnvNames = [],
  } = opts;
  const args = buildClaudeArgs({ permissionMode, maxTurns });

  return {
    async run({ prompt, cwd, log = () => {}, onEvent = () => {}, signal }) {
      const safeLog = (line) => { try { log(line); } catch { /* never throw from logging */ } };
      /** @type {ClaudeJsonResult|null} */
      let streamResult = null;
      const onStdoutLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { return; }
        if (isResult(obj)) streamResult = obj;
        let events = [];
        try { events = toEvents(obj); } catch { /* unknown shape: ignore */ }
        for (const [type, data] of events) {
          try { onEvent(type, data); } catch { /* never throw from event delivery */ }
        }
      };
      try {
        safeLog(`[claude] $ ${claudeBin} ${args.join(' ')}`);
        const r = await run({
          cmd: claudeBin,
          args,
          cwd,
          env: buildClaudeEnv(baseEnv, secretEnvNames),
          stdin: prompt,
          timeoutMs,
          killGraceMs,
          signal,
          lineStdout: true,
          onLine: (l, s) => { if (s === 'stderr') safeLog(`[claude:stderr] ${l}`); else onStdoutLine(l); },
        });
        const parsed = streamResult ?? parseClaudeJson(r.stdout);
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
 * Exactly: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode, '--max-turns', String(maxTurns)]
 * (stream-json requires --verbose in print mode.)
 * (--max-turns is accepted by claude 2.x even though it's hidden from --help.)
 *
 * @param {{ permissionMode: string, maxTurns: number }} p
 * @returns {string[]}
 */
export function buildClaudeArgs(p) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', p.permissionMode, '--max-turns', String(p.maxTurns),
  ];
}

/**
 * Child env: baseEnv minus service secrets (withoutSecrets: API_KEY, ADMIN_PASSWORD, MASTER_KEY*, GIT_TOKEN*,
 * secretEnvNames) and minus STRIPPED_ENV_VARS (so the ~/.claude subscription login is used). Never mutates baseEnv.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {Iterable<string>} [secretEnvNames=[]]  env vars holding a stored repo token (any name)
 * @returns {NodeJS.ProcessEnv}
 */
export function buildClaudeEnv(baseEnv, secretEnvNames = []) {
  const env = withoutSecrets(baseEnv, secretEnvNames);
  for (const k of STRIPPED_ENV_VARS) delete env[k];
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

// ---------------------------------------------------------------------------------------------------------
// stream-json -> live events
// ---------------------------------------------------------------------------------------------------------

/** Max chars of any text field sent in a live event (tool output can be huge and may contain secrets). */
export const MAX_EVENT_TEXT = 4000;
/** Max serialized size of a tool_use input kept as an object; larger inputs become { _truncated, preview }. */
export const MAX_EVENT_INPUT = 4000;

const clip = (v, max = MAX_EVENT_TEXT) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > max ? { text: s.slice(0, max), truncated: true, length: s.length } : { text: s, truncated: false, length: s.length };
};

/**
 * Map ONE parsed stream-json line to zero or more live events `[type, data]`.
 * The format is not formally versioned, so this is deliberately defensive: unknown line types / content
 * blocks yield no events and never throw.
 *
 *  system/init            -> init { session_id, model, tools }
 *  assistant text block   -> assistant_text { text, truncated }
 *  assistant thinking     -> thinking { text, truncated, redacted }   (only present when extended thinking is on;
 *                                                                      may be summarized / redacted by the API)
 *  assistant tool_use     -> tool_use { id, name, input }              (input truncated, see MAX_EVENT_INPUT)
 *  user tool_result       -> tool_result { tool_use_id, is_error, text, truncated }
 *  result                 -> (none; the job store emits the terminal `result` event on the status transition)
 *
 * @param {any} obj
 * @returns {Array<[string, object]>}
 */
export function toEvents(obj) {
  if (obj === null || typeof obj !== 'object') return [];
  if (obj.type === 'system' && obj.subtype === 'init') {
    return [['init', { session_id: obj.session_id ?? null, model: obj.model ?? null, tools: Array.isArray(obj.tools) ? obj.tools : [] }]];
  }
  const content = obj.message?.content;
  if ((obj.type !== 'assistant' && obj.type !== 'user') || !Array.isArray(content)) return [];
  /** @type {Array<[string, object]>} */
  const out = [];
  for (const b of content) {
    if (b === null || typeof b !== 'object') continue;
    if (obj.type === 'assistant') {
      if (b.type === 'text' && typeof b.text === 'string') {
        const c = clip(b.text);
        out.push(['assistant_text', { text: c.text, truncated: c.truncated }]);
      } else if (b.type === 'thinking') {
        const c = clip(typeof b.thinking === 'string' ? b.thinking : '');
        out.push(['thinking', { text: c.text, truncated: c.truncated, redacted: c.text === '' }]);
      } else if (b.type === 'redacted_thinking') {
        out.push(['thinking', { text: '', truncated: false, redacted: true }]);
      } else if (b.type === 'tool_use') {
        const raw = JSON.stringify(b.input ?? {});
        const input = raw.length <= MAX_EVENT_INPUT ? (b.input ?? {}) : { _truncated: true, preview: raw.slice(0, MAX_EVENT_INPUT) };
        out.push(['tool_use', { id: b.id ?? null, name: b.name ?? null, input }]);
      }
    } else if (b.type === 'tool_result') {
      const body = Array.isArray(b.content)
        ? b.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('')
        : (b.content ?? '');
      const c = clip(body);
      out.push(['tool_result', { tool_use_id: b.tool_use_id ?? null, is_error: b.is_error === true, text: c.text, truncated: c.truncated }]);
    }
  }
  return out;
}
