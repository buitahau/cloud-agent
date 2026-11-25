# Cloud Agent v1 — Implementation Plan

> **Update:** the service now supports several repos and an admin dashboard. That design, and what changed
> from the single-repo version described below, is in [MULTI_REPO_PLAN.md](MULTI_REPO_PLAN.md). Where this file
> mentions `REPO_URL`, `REPO_BRANCH`, `WORKSPACE_DIR`, `GIT_TOKEN`, `GIT_SSH_KEY_PATH` or `/run-agent`, read
> "the repo's entry in `REPOS_FILE`" and `/<repo>/run-agent`.

Read `docs/PROJECT_OVERVIEW.md` (the spec) first. This file covers **how** to build it. Every
design decision is already made here or in the JSDoc of each `src/` module. When this file and a JSDoc
comment disagree, the JSDoc wins (it sits next to the code). Don't add dependencies.

Runtime: Node 18.20 (ESM, global `fetch`, `node --test`; no `--env-file`, no `mock.timers`). Deps: `express@4`, `dotenv@16`.

---

## 1. File layout

```
package.json            scripts: start | dev (node --watch) | test (node --test test/) | test:e2e
.env.example            spec §4 + optional extras (CLAUDE_BIN, CLAUDE_AUTH_PROBE, GIT_TIMEOUT_SECONDS, LOGS_TAIL_LINES)
src/
  index.js              entry: dotenv -> loadConfig -> checkClaudeAuth -> wire -> listen -> signal handling
  config.js             loadConfig(env) pure + validate, ConfigError, expandHome, redactConfig
  claudeAuth.js         checkClaudeAuth(): --version, `auth status --json`, optional 1-turn probe   (T1)
  jobStore.js           in-memory jobs, STATUS/TRANSITIONS, toPublic()                              (§5, §6)
  worker.js             FIFO queue, one job at a time, processJob()                                 (T3, T11)
  gitSync.js            clone/fetch/checkout/reset/clean/rev-parse, buildGitEnv()                    (T5, T6, T12)
  claudeRunner.js       spawn `claude -p`, timeout, parse JSON, classify outcome                    (T9, T10)
  server.js             express app, x-api-key auth, routes                                         (T2, T4)
  lib/processRunner.js  runProcess(): the ONLY spawn site; process-group kill; never rejects
  lib/logBuffer.js      LogBuffer (ring buffer -> logs_tail), LineSplitter
  lib/validate.js       isValidBranchName, validateRunAgentBody, MAX_PROMPT_LENGTH
test/                   *.test.js stubs (todo tests), one file per module + startup + opt-in e2e
test-support/           fake-claude.js (COMPLETE), gitFixture.js (COMPLETE) — kept outside test/ on purpose
```

> **Why `test-support/` and not `test/fixtures/`:** Node 18's `node --test test/` executes *every* `.js`
> file under a directory named `test`, helpers included. Don't move them.

---

## 2. Implementation order

Do each step, then turn the matching `test/*.test.js` todos into real tests (remove `{ todo }`) and get them green before moving on.

1. `lib/validate.js`, `lib/logBuffer.js` → `validate.test.js`
2. `config.js` → `config.test.js`
3. `lib/processRunner.js` → `processRunner.test.js` (**the T10 tree-kill test must pass here**)
4. `jobStore.js` → `jobStore.test.js`
5. `claudeRunner.js` → `claudeRunner.test.js`
6. `claudeAuth.js` → `claudeAuth.test.js`
7. `gitSync.js` → `gitSync.test.js`
8. `worker.js` → `worker.test.js`
9. `server.js` → `server.test.js`
10. `index.js` → `startup.test.js`
11. Manual: fill `.env`, `npm start`, run the spec §8 smoke test; then `npm run test:e2e` (T3/T5–T8).

`npm test` must stay green, with no network access and no real `claude`, at every step.

---

## 3. Module contracts (summary; full JSDoc in each file)

| Module | Export | Contract |
|---|---|---|
| config | `loadConfig(env, {cwd}) → Config` | pure, throws `ConfigError(problems[])`, frozen result, absolute `workspaceDir` |
| processRunner | `runProcess(RunOptions) → Promise<RunResult>` | never rejects; `{code, signal, stdout, stderr, timedOut, aborted, truncated, spawnError, durationMs}` |
| claudeAuth | `checkClaudeAuth({claudeBin, probe, run?, baseEnv?}) → {ok, version, authMethod, probed}` | throws `ClaudeAuthError(step)` with step `binary`, `status` or `probe` |
| jobStore | `createJobStore({now?, genId?, logsTailLines?, logCapacity?})` | `create, get, transition, update, appendLog, toPublic, list` (all sync) |
| gitSync | `createGitSync({repoUrl, workspaceDir, sshKeyPath?, token?, timeoutMs, gitBin?, run?, baseEnv?})` | `.sync(branch, log?, signal?) → {commit}`; throws `GitSyncError(step)` |
| claudeRunner | `createClaudeRunner({claudeBin, permissionMode, maxTurns, timeoutMs, killGraceMs?, run?, baseEnv?})` | `.run({prompt, cwd, log?, signal?}) → {outcome, result, error, meta}`; never rejects |
| worker | `createWorker({store, gitSync, claudeRunner, workspaceDir, logger?})` | `enqueue (sync), queueLength, currentJobId, onIdle, shutdown`; `processJob` never throws |
| server | `createApp({config, store, worker, logger?})`, `startServer(app, port)` | no listen inside createApp; port 0 in tests |

**Dependency injection:** `gitSync`, `claudeRunner`, and `claudeAuth` take an optional `run` (defaults to `runProcess`)
and `baseEnv` (defaults to `process.env`). Tests either point `claudeBin` at `test-support/fake-claude.js` with
the real `runProcess`, or pass a stub `run` that returns canned `RunResult`s. The worker gets `gitSync` and
`claudeRunner` objects, so worker tests can use simple stubs with deferred promises.

---

## 4. Job record

API fields keep the exact names from spec §5. Public shape (`store.toPublic`), in key order:

```jsonc
{
  "id": "job_3f2a…(32 hex)",     // "job_" + randomUUID without dashes
  "status": "queued",            // queued | pulling | running | succeeded | failed | timeout
  "prompt": "…",                 // as submitted (not trimmed)
  "branch": "dev",               // effective branch, fixed at creation: body.branch ?? REPO_BRANCH
  "commit": null,                // `git rev-parse --short HEAD` after sync
  "created_at": "2026-11-25T10:00:00.000Z",
  "started_at": null,            // set on -> pulling
  "finished_at": null,           // set on -> succeeded | failed | timeout
  "result": null,                // parsed JSON .result, whenever claude produced parseable output (even on failure)
  "error": null,                 // non-null iff status is failed or timeout
  "logs_tail": "",               // last LOGS_TAIL_LINES lines of the job log, "\n"-joined
  "claude": null                 // ADDITIVE: {session_id,total_cost_usd,num_turns,duration_ms,subtype,is_error} or null
}
```

The spec says to store "result / is_error / cost / session_id" (§6 step 3). Those values go in the nested
`claude` object so the spec's top-level field set stays as written. Timestamps come from `Date#toISOString()`,
so they include milliseconds.

## 5. Status transitions

```
queued  -> pulling | failed          (failed: shutdown / internal error before start)
pulling -> running | failed          (failed: any git error, git command timeout, abort)
running -> succeeded | failed | timeout
terminal: succeeded, failed, timeout (no exits)
```

`jobStore.transition` enforces this (`IllegalTransitionError`) and is the only code that sets `status`.
Each transition appends `[job] <from> -> <to>` to the job log.

---

## 6. Error-handling rules

1. **`runProcess` never rejects.** Spawn errors, non-zero exits, and timeouts all come back as data.
2. **`processJob` never throws.** Each failure becomes a terminal status with a human-readable `error`:
   - git: `git <step> failed: <last stderr line | "timed out after Ns" | spawn error>` → `failed`
   - claude timeout: `Timed out after Ns; claude process killed` → `timeout`
   - claude error: `claude reported an error (<subtype>): <result text>` (≤2000 chars) → `failed`
   - claude output can't be parsed: `claude exited with <code|signal>; unparseable output: <last stderr line>` → `failed`
   - anything unexpected: `Internal error: <message>` → `failed` (stack goes to `logger.error`)
3. **Success requires `exit code 0 AND parsed.is_error === false`.** Verified on claude 2.1.x: a bad login
   gives `subtype: "success"`, `is_error: true`, exit 1. Never decide success from `subtype` alone.
4. **The worker loop survives everything.** A bug in one job must not stop later jobs or crash the process
   (T9). `index.js` logs `unhandledRejection` and does not exit.
5. **HTTP errors are always JSON `{ error }`:** 400 validation or bad JSON, 401 bad key, 404 unknown id or route,
   413 body too large, 500 internal.
6. **Secrets** (API_KEY, GIT_TOKEN) never appear in logs, errors, argv, or
   `.git/config`. `auth status` stdout is never logged because it contains the account email and org.

---

## 7. Decisions

### Timeout and process-tree kill (T10)
- `runProcess` spawns with `detached: true`, so the child leads a **new process group**. claude's tool
  subprocesses (bash, test runners, browsers) join that group.
- On timeout or abort: `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` to the group after `killGraceMs`
  (default 5000). Resolve on `'close'`. As a safety net, resolve 2s after SIGKILL even if stdio is still open.
- Side effect: detached children survive our own death. So `index.js` handles SIGINT/SIGTERM by calling
  `worker.shutdown()`, which aborts the running job and kills its group. A `kill -9` of the service will
  orphan the run (accepted for the PoC).
- `JOB_TIMEOUT_SECONDS` covers **only the claude step**. That matches the spec diagram, where `timeout` is
  reachable only from `running`. Each git command has its own `GIT_TIMEOUT_SECONDS` (default 300), and going
  over it gives `failed`, not `timeout`.

### Invoking claude
- Exact argv: `-p --output-format json --permission-mode <mode> --max-turns <n>`, with `cwd = WORKSPACE_DIR`.
- **The prompt goes on stdin, not argv.** This avoids argv length limits and prompts that start with `-`
  being read as flags. stdin is always closed after writing, because `claude -p` blocks on an open stdin.
  Verified: `echo hi | claude -p --output-format json` works.
- `--max-turns` works on 2.x even though `--help` doesn't list it.
- Child env is `process.env` minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (they would move billing off
  the subscription), and `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (set when the service runs inside a Claude
  Code session), and `CLAUDE_CODE_OAUTH_TOKEN` (would override the machine login). Auth always comes from
  the subscription login in `~/.claude` of the OS user running the service.
- JSON parsing: `JSON.parse(stdout.trim())`. If that fails, take the last stdout line that starts with `{`
  and parses to `type === "result"`. If nothing matches, treat the output as unparseable.

### logs_tail
- Each job has a `LogBuffer`: 500-line ring, lines capped at 2000 characters. `logs_tail` is the last
  `LOGS_TAIL_LINES` lines (default 50).
- It holds:
  - `[job] a -> b` transitions
  - `[git] $ git …` commands and every git output line
  - `[claude] $ claude …` (no prompt)
  - every claude stderr line as `[claude:stderr] …`
  - a summary line `[claude] exit=… subtype=… turns=… cost_usd=… duration_ms=…`
  - if the JSON can't be parsed, the last 20 stdout lines as `[claude:stdout] …`
- Claude's stdout JSON is **not** line-logged (`lineStdout: false`). It is one large blob, and its `.result`
  is already in `result`.

### Startup auth check (T1)
- Auth = the Claude subscription already logged in on this machine (no token in `.env`).
  `claude auth status --json` must report `loggedIn: true` **and** `authMethod: "claude.ai"`, else step `status` fails.
- `auth status` alone isn't enough: it only checks stored credentials exist, not that they still work. So by default we also run a 1-turn probe (`CLAUDE_AUTH_PROBE=true`):
  `claude -p --output-format json --max-turns 1` with prompt `Reply with exactly: OK`, run in `os.tmpdir()`.
  It costs a few cents per boot. Set `CLAUDE_AUTH_PROBE=false` to skip it, but then T1's invalid-login case
  is only caught by the first job.
- Success log line, which T1 checks: `Claude auth OK (...)`. On failure: `ClaudeAuthError` message on stderr, exit 1.

### Git sync
- First run: `git clone --no-checkout -- <url> <dir>`. If it fails, `rm -rf` the dir so the next job clones fresh.
- Each job:
  1. `fetch --prune origin +refs/heads/B:refs/remotes/origin/B`
  2. `checkout -f -B B origin/B`
  3. `reset --hard origin/B`
  4. `clean -fdx -e node_modules`
  5. `rev-parse --short HEAD`
- `checkout -f -B` replaces the spec's `checkout -f B` because it also works when the local branch doesn't
  exist yet (T6 with a branch created after the clone).
- Git auth goes through env only (`GIT_TERMINAL_PROMPT=0`):
  - SSH: `GIT_SSH_COMMAND="ssh -i '<key>' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"`
  - HTTPS with a token: `GIT_CONFIG_COUNT/KEY_0/VALUE_0` setting `http.extraHeader: Authorization: Basic base64("x-access-token:<token>")`.
    Needs git ≥ 2.31; the host has 2.34.
- Branch names are validated (`isValidBranchName`) in POST (400) and again in `gitSync` (defense in depth).
- The workspace is **not** cloned at startup. The first job clones it, so a bad `REPO_URL` produces a
  `failed` job (T9) and doesn't crash the service.

### Other
- Job ids use `crypto.randomUUID()`, not ULID, to avoid a dependency. The `job_` prefix is kept.
- API key comparison: sha256 both values, then `timingSafeEqual`.
- `GET /health` has no auth. It is an extra, not in the spec.
- Config extras beyond spec §4, all optional with defaults: `CLAUDE_BIN`, `CLAUDE_AUTH_PROBE`, `GIT_TIMEOUT_SECONDS`, `LOGS_TAIL_LINES`.

---

## 8. Deliberate simplifications vs. the spec

- Jobs are in memory, optionally persisted to a JSONL file (`JOBS_FILE`, under the git-ignored `data/`); finished
  jobs beyond `JOB_RETENTION_MAX` are dropped. No SQLite.
- One workspace per repo; at most one job per repo at a time and `MAX_CONCURRENT_JOBS` overall (default 1 =
  strict FIFO, as §7 of the spec says). No worktrees.
- There is no cancel endpoint. `shutdown()` is the only abort path.
- `logs_tail` is a bounded tail, not a full transcript.
- `GIT_TOKEN` header injection is written for GitHub (`x-access-token`). Other hosts may need a different username.
- A workspace that holds a clone of a *different* repo is detected (`git remote get-url origin`) and the job
  fails with a "delete it so it is re-cloned" error. It is never deleted automatically.

---

## 9. Watch-outs for the implementer

- **Don't run as root with `bypassPermissions`.** claude refuses it. `index.js` warns about it.
- **Never use `shell: true`** or string-built commands. Always use argv arrays.
- **Don't `await` the job in POST.** `enqueue` is synchronous, and the drain starts on `setImmediate`.
- **Compare commits with `fullSha.startsWith(job.commit)`** in tests. Short-sha length can differ between clones.
- **`startup.test.js`** must spawn `src/index.js` with `cwd` set to a temp dir. Otherwise dotenv loads the developer's real `.env`.
- Keep tests fast. Use `killGraceMs` of about 200 and timeouts of about 500 ms with the fake binary. The suite
  needs no network and no real claude.
- dotenv 16 removes inline `# comments` from unquoted values, so `.env.example` lines like
  `REPO_BRANCH=dev   # …` parse correctly. Don't quote those values.
- `test-support/fake-claude.js` modes (`[[fake:success|error|max_turns|garbage|stderr|sleep=N|junk|cat=FILE|pwd]]`,
  plus `FAKE_CLAUDE_AUTH=invalid|logged_out`, `FAKE_CLAUDE_RECORD`, `FAKE_CLAUDE_PIDFILE`) are documented at
  the top of that file. Extend it there if a test needs a new behaviour.
