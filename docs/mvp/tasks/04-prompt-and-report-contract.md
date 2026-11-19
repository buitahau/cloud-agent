# 04 — Run prompt and report contract

**Estimate:** M · **Depends on:** 03

## Goal
Fix the prompt, the report format, the guard against a false green (A5), and the runner contract, so that the runner can classify a run without interpreting free text and the server (task 07) can be built against a fixed interface. **`pw.json` and the suite command's exit status are the authority for pass/fail and counts; the agent only writes the diagnosis.**

## Scope
- In: the prompt file, report grammar, the E2E script and instructions in the target repo, the classification tables (the single list of statuses and reasons for the whole plan), the runner contract (`meta.json` fields, exit codes).
- Out: runner code (task 05). This task produces the spec and the prompt file that task 05 uses.

## Steps
1. In the **target repo**, commit:
   - `package.json` script `"e2e:ci": "playwright test --reporter=list,json"` (the only command the VPS agent may run).
   - Failure screenshots in the Playwright config, if task 02 found them missing.
   - A `CLAUDE.md` "E2E" section: the command `npm run e2e:ci`, the env vars it reads (`BASE_URL`, …), "dependencies and browsers are already installed; run the suite once, in full, in the foreground; do not pass extra arguments".
   - If the repo has CI triggered by branch pushes, exclude `agent/**` (every run force-pushes `agent/test`).
2. Write `vps/prompt.md` in this repo:
   > You are the remote E2E test runner. Rules about `cloudtest` or about not running tests locally do not apply to you. Read CLAUDE.md, then run `npm run e2e:ci` exactly once, in the foreground (do not run it in the background), with no extra arguments, no pipes and no other commands. Do not modify, create, or delete files. When finished, output ONLY the report below.
   > Line 1 must be one of: `RESULT: PASS (<p> passed, <f> failed)`, `RESULT: FAIL (<p> passed, <f> failed)`, `RESULT: ERROR <one-line reason>` (use ERROR only if the suite could not run: environment unreachable, config error).
   > Then, for each failed test: `N. <file>:<line> "<title>" — <error summary>` / `   cause: <likely cause>` / `   screenshot: test-results/<…>.png` (the path as Playwright printed it, relative to the repo root).
3. Report grammar regex for line 1: `^RESULT: (PASS|FAIL) \((\d+) passed, (\d+) failed\)$|^RESULT: ERROR (.+)$`.
4. Count mapping from `pw.json` `stats`: **passed = `expected` + `flaky`**, **failed = `unexpected`**, `skipped` is ignored (not counted either way). Total = passed + failed.
5. Screenshot paths: the runner copies `wt/test-results/` to `<run_dir>/artifacts/test-results/`, so every `screenshot:` path in the report resolves under `<run_dir>/artifacts/`. The CLI prints the absolute run dir.
6. Classification tables. This is the only list of statuses and reasons in the plan; README §4 links here.

   **Before claude** (`run-once.sh`, task 05; the first failure ends the run):

   | # | Condition | status | reason |
   |---|---|---|---|
   | 1 | `git fetch origin <sha>` fails or times out | error | `fetch failed: <first git error line>` |
   | 2 | `npm ci` or `playwright install chromium` fails or times out | error | `install failed: <step>` |

   **After claude** (`classify.mjs`, task 05). Rows are checked **top to bottom; the first match wins**. "Suite call" means a `Bash` `tool_use` with command `npm run e2e:ci` whose `tool_result` is not a permission denial (task 03 step 6).

   | # | Condition | status | result | reason |
   |---|---|---|---|---|
   | 3 | the claude `timeout` wrapper exits 124, or exits 137 **and** claude ran ≥ `TIMEOUT_MIN` | timeout | — | `timeout after <N> min` |
   | 4 | auth signature from task 03 | error | — | `claude auth failed` |
   | 5 | `subtype=error_max_turns` (or the budget-cap signature) | error | — | `agent exceeded max turns` |
   | 6 | no `result` event, `is_error=true`, or claude exit ≠ 0 (an exit 137 that is not row 3 gives `killed (signal 9)`; a usage-limit message lands here too) | error | — | `claude failed: <first 200 chars of result or claude.err>` |
   | 7 | number of suite calls ≠ 1 | error | — | `suite run <n> times` |
   | 8 | `pw.json` missing or not valid JSON | error | — | `no playwright result` |
   | 9 | `pw.json` top-level `errors` non-empty | error | — | `playwright error: <first message>` |
   | 10 | total (passed + failed) = 0 | error | — | `no tests ran` |
   | 11 | the suite call's `tool_result` shows a non-zero exit and `unexpected` = 0 | error | — | `suite exited non-zero with no failed test` |
   | 12 | `unexpected` = 0 | done | pass | — |
   | 13 | `unexpected` > 0 | done | fail | — |

   The agent's own line 1 never decides a status. If it says `RESULT: ERROR …` and `pw.json` is valid, the result comes from `pw.json` and `agent_line_ok` is `false`.

   **Out-of-band** (written by another actor, at another time; they apply only when no row above was written):

   | # | Condition (set by) | status | reason |
   |---|---|---|---|
   | O1 | runner's exit trap fires with no final status written (runner) | error | `runner crashed` |
   | O2 | meta still `queued`/`running` after the runner exits (server) | error | `runner exited <code>` |
   | O3 | meta `running` at server startup (server) | error | `worker restarted` |

   **`report.md`** is written by the runner for every row 1–13. Line 1 is built by the runner, not taken from the agent: `RESULT: PASS|FAIL (<p> passed, <f> failed)` from `pw.json` for rows 12–13, `RESULT: ERROR <reason>` otherwise (including row 3). Then: if the agent's first line matches the regex, the rest of its text; if it does not match (e.g. a preamble), all of its text; with no agent text, line 1 only. For O1–O3 `report.md` may be missing; the CLI then prints `reason`. `agent_line_ok` is `true` when the agent's line 1 matches the regex and equals the runner's line; it is a measurement of A5 (task 11), not an error.

   Note: the architecture doc (§7) calls row 4 `claude login expired`. The plan uses `claude auth failed` because it also covers an invalid long-lived token.

7. Hand-run the prompt twice (one green SHA, one with a broken assertion) using the task 03 command line, and check the outputs against the regex and rows 7–13. Copy both runs' `transcript.jsonl` and `pw.json` to the laptop (check them for secrets first): they are the fixtures for rows 12–13 in task 05.
8. Restore the clone before task 05: `git -C /var/lib/cloudtest/repo checkout -- . && git -C /var/lib/cloudtest/repo clean -fd` (removes the spike's `package.json` edit and any temporary `.claude/settings.json`), then check out the default branch.

## Runner contract
Tasks 05 (runner), 06 and 07 (server, fake runner) use this section.

- Call: `run-once.sh <run_dir> <sha>`. It writes nothing to stdout/stderr; its log goes to `<run_dir>/run.log`.
- Run directory: `<run_dir>/{meta.json, report.md, transcript.jsonl, claude.json, claude.err, pw.json, run.log, artifacts/test-results/}`.
- `meta.json` writes are merges (`jq '. + $patch'` to a tmp file, then `mv`). While the runner runs it is the only writer.
  - At creation (server, or the runner on the SSH path): `{id, project, sha, status: "queued", created_at}`.
  - Runner start: `{status: "running", started_at, claude_version}`.
  - Runner end: `{status, result, reason, finished_at, claude_exit, num_turns, duration_ms, passed, failed, agent_line_ok, fetch_ms, install_ms, claude_ms, tests_ms}` (`tests_ms` = `pw.json` `stats.duration`; fields that do not apply are `null`).
  - Server: only O2 and O3, as `{status: "error", reason, finished_at}`.
- Runner exit codes: `0` done/pass · `1` done/fail · `2` error · `3` timeout · `75` busy (lock held; nothing created or changed). The CLI mirrors 0–3.

## Acceptance criteria
- [ ] `vps/prompt.md` and this file are committed in this repo. The target repo's `e2e:ci` script, `CLAUDE.md` E2E section (and screenshot config, if needed) are committed.
- [ ] In both hand runs, the agent's line 1 matches the regex and equals the line built from `pw.json` per step 4, exactly one suite call is in the transcript, and that call's exit status agrees with `unexpected` (non-zero only when `unexpected` > 0).
- [ ] The red run lists the broken test with the correct `file:line` and a `test-results/…png` screenshot path that exists in the clone.
- [ ] After step 8, `git -C /var/lib/cloudtest/repo status --porcelain` prints nothing.
