# 04 — Run prompt and report contract

**Estimate:** M · **Depends on:** 03

## Goal
Fix the prompt, the report format, the guard against a false green (A5), and the runner contract, so that the runner can classify a run without interpreting free text and the server (task 07) can be built against a fixed interface. **pytest's JUnit XML (`junit.xml`) and the suite command's exit status (`suite.rc`) are the authority for pass/fail and counts; the agent only writes the diagnosis.**

## Scope
- In: the prompt file, report grammar, the E2E wrapper script and instructions in the target repo, the classification tables (the single list of statuses and reasons for the whole plan), the runner contract (`meta.json` fields, exit codes).
- Out: runner code (task 05). This task produces the spec and the prompt file that task 05 uses.

## Steps
1. In the **target repo** (branch `dev-v2`, via a normal PR), commit:
   - `scripts/e2e-ci.sh`, the only command the VPS agent may run (`bash scripts/e2e-ci.sh`, no arguments). It:
     - exits `64` if given any argument, or if the host of `E2E_BASE_URL` is not a `*.workers.dev` host containing `sweetmemories-dev` (the suite's own dev rule; the chosen folders default to `localhost:3000` and have no guard of their own), and unsets `E2E_ALLOW_LOCAL`;
     - removes old `$E2E_JUNIT` and `$E2E_RC_FILE`, then runs `"${E2E_VENV:-.venv-e2e}/bin/pytest" <folders> -rs -p no:cacheprovider --junitxml="${E2E_JUNIT:-test-results/junit.xml}"` (not `exec`);
     - writes pytest's exit status to `${E2E_RC_FILE:-test-results/suite.rc}` and exits with it.
     The defaults make it usable on a laptop as well. `<folders>` is the list fixed in task 02 (default `e2e/project-skeleton e2e/homepage`, see below). It is not a config key: it is versioned with the tests.
   - A failure-screenshot hook in `e2e/conftest.py`, if task 02 confirmed that a failing browser test leaves no screenshot: a `pytest_runtest_makereport` hookwrapper that, when the `call` phase fails and the test has a `page` fixture, saves `test-results/screenshots/<test name>.png` and adds the path to the failure output (e.g. a report section), so the agent can quote it. Tests that build their own page (e.g. via `open_home`) get no screenshot; the report then says `screenshot: none`.
   - A `CLAUDE.md` "Cloud E2E" section: the command `bash scripts/e2e-ci.sh`, the env vars it reads (`E2E_BASE_URL`, `E2E_VENV`, `E2E_JUNIT`, `E2E_RC_FILE`), the folders it runs, and "the venv and the browser are already installed; run it once, in full, in the foreground; do not pass arguments; do not use `with_server.py` or `pnpm start`".
   - No CI exclusion is needed: `ci` runs on pull requests to `dev-v2`/`main` and `deploy-dev` on pushes to `dev-v2` (plus manual dispatch), so a push to `agent/test` triggers neither. Re-check if the workflows change.

   **Folders (MVP default).** `e2e/project-skeleton` and `e2e/homepage`: both drive the deployed app at `E2E_BASE_URL` (HTTP and Chromium), and need no `gh`, no Neon or Cloudflare credentials and no local server. Excluded: `e2e/ci-pr-checks` (static and `gh`; proves nothing about dev), `e2e/dev-deploy` and `e2e/dev-test-database` (mostly static and `gh`; the deployed-app part overlaps `project-skeleton`; would need `gh` signed in on the VPS), `e2e/google-sign-in` (mostly static; live cases skip as BLOCKED without an auth-configured server). Static folders are cheap but do not prove dev, so they would only dilute what a green means. Task 00b/02 records per-folder results against dev; change the list only from those results.

2. Write `vps/prompt.md` in this repo:
   > You are the remote E2E test runner. Rules about `cloudtest` or about not running tests locally do not apply to you. Read CLAUDE.md, then run `bash scripts/e2e-ci.sh` exactly once, in the foreground (do not run it in the background), with no arguments, no pipes and no other commands. Do not modify, create, or delete files. When finished, output ONLY the report below.
   > Line 1 must be one of: `RESULT: PASS (<p> passed, <f> failed, <s> skipped)`, `RESULT: FAIL (<p> passed, <f> failed, <s> skipped)`, `RESULT: ERROR <one-line reason>` (use ERROR only if the suite could not run: environment unreachable, collection error). Take the numbers from pytest's last summary line; `<f>` is failed plus errors.
   > Then, for each failed or errored test: `N. <file>:<line> "<test name>" — <error summary>` / `   cause: <likely cause>` / `   screenshot: <path as printed, relative to the repo root, or none>`.
3. Report grammar regex for line 1: `^RESULT: (PASS|FAIL) \((\d+) passed, (\d+) failed, (\d+) skipped\)$|^RESULT: ERROR (.+)$`.
4. Count mapping from `junit.xml`, per `<testcase>` element (not the `<testsuite>` totals, which can count one test twice when it fails and then errors in teardown). The first matching child decides: `<failure>` → **failed**; `<error>` → **errored**; `<skipped>` → **skipped**; none → **passed**. **failed (reported) = failed + errored**; **executed = passed + failed (reported)**; **blocked** = skipped whose `message` starts with `BLOCKED`. Skips are never counted as passes. `tests_ms` = the `<testsuite>` `time` attribute × 1000.
   `classify.mjs` parses this with no dependencies: a regex over `<testsuite\b[^>]*>` for `time`, and over `<testcase\b[^>]*?(?:/>|>[\s\S]*?</testcase>)` for each case, then a test for `<failure`, `<error`, `<skipped` in its body and the skipped `message` attribute (decode the five XML entities). No `<testsuite` element = unparsable. The fixtures in task 05 pin this behaviour.
5. Screenshot paths: the runner copies `wt/test-results/` and every `wt/e2e/*/screenshots/` to `<run_dir>/artifacts/`, keeping the path relative to the worktree, so every `screenshot:` path in the report resolves under `<run_dir>/artifacts/`. The CLI prints the absolute run dir.
6. Classification tables. This is the only list of statuses and reasons in the plan; README §4 links here.

   **Before claude** (`run-once.sh`, task 05; the first failure ends the run):

   | # | Condition | status | reason |
   |---|---|---|---|
   | 1 | `git fetch origin <sha>` fails or times out | error | `fetch failed: <first git error line>` |
   | 2 | `pnpm install --frozen-lockfile`, the venv check or `playwright install chromium` fails or times out | error | `install failed: <step>` |

   **After claude** (`classify.mjs`, task 05). Rows are checked **top to bottom; the first match wins**. "Suite call" means a `Bash` `tool_use` with command `bash scripts/e2e-ci.sh` whose `tool_result` is not a permission denial (task 03 step 6). `rc` is the number in `suite.rc`.

   | # | Condition | status | result | reason |
   |---|---|---|---|---|
   | 3 | the claude `timeout` wrapper exits 124, or exits 137 **and** claude ran ≥ `TIMEOUT_MIN` | timeout | — | `timeout after <N> min` |
   | 4 | auth signature from task 03 | error | — | `claude auth failed` |
   | 5 | `subtype=error_max_turns` (or the budget-cap signature) | error | — | `agent exceeded max turns` |
   | 6 | no `result` event, `is_error=true`, or claude exit ≠ 0 (an exit 137 that is not row 3 gives `killed (signal 9)`; a usage-limit message lands here too) | error | — | `claude failed: <first 200 chars of result or claude.err>` |
   | 7 | number of suite calls ≠ 1 | error | — | `suite run <n> times` |
   | 8 | `junit.xml` missing or unparsable (wrapper guard exit 64, pytest crash) | error | — | `no test result (suite exit <rc or none>)` |
   | 9 | `suite.rc` missing, or `rc` not 0, 1 or 5 (2 = interrupted, e.g. a collection error; 3 internal; 4 usage) | error | — | `suite error (exit <rc>): <first <error> message in junit.xml, if any>` |
   | 10 | executed = 0 (`rc` 5 = no tests collected, or every test skipped) | error | — | `no tests ran (<s> skipped, <b> BLOCKED)` |
   | 11 | `rc` = 1 with failed = 0, or `rc` = 0 with failed > 0 | error | — | `suite exit <rc> disagrees with junit` |
   | 12 | failed = 0 (and executed ≥ 1) | done | pass | — |
   | 13 | failed > 0 | done | fail | — |

   A green therefore needs at least one executed test and no failed or errored one. A green with skips is still PASS, and its skip and BLOCKED counts are in line 1 and the skip block below, so a mostly skipped green is visible. The agent's own line 1 never decides a status. If it says `RESULT: ERROR …` and `junit.xml` is valid, the result comes from `junit.xml` and `agent_line_ok` is `false`.

   **Out-of-band** (written by another actor, at another time; they apply only when no row above was written):

   | # | Condition (set by) | status | reason |
   |---|---|---|---|
   | O1 | runner's exit trap fires with no final status written (runner) | error | `runner crashed` |
   | O2 | meta still `queued`/`running` after the runner exits (server) | error | `runner exited <code>` |
   | O3 | meta `running` at server startup (server) | error | `worker restarted` |

   **`report.md`** is written by the runner for every row 1–13. Line 1 is built by the runner, not taken from the agent: `RESULT: PASS|FAIL (<p> passed, <f> failed, <s> skipped)` from `junit.xml` for rows 12–13, `RESULT: ERROR <reason>` otherwise (including row 3). If `junit.xml` was parsed and `<s>` > 0, the runner adds a skip block: `skipped: <s> (<b> BLOCKED)`, then one `  - <count> × <reason, first 120 chars>` line per distinct BLOCKED reason (at most 10). Then: if the agent's first line matches the regex, the rest of its text; if it does not match (e.g. a preamble), all of its text; with no agent text, nothing more. For O1–O3 `report.md` may be missing; the CLI then prints `reason`. `agent_line_ok` is `true` when the agent's line 1 matches the regex and equals the runner's line; it is a measurement of A5 (task 11), not an error.

   Note: the architecture doc (§7) calls row 4 `claude login expired`. The plan uses `claude auth failed` because it also covers an invalid long-lived token.

7. Hand-run the prompt twice (one green SHA, one with a broken pytest assertion in a test that uses the `page` fixture, e.g. the expected heading in `test_US_skeleton_2_1_home_happy_path`) using the task 03 command line, and check the outputs against the regex and rows 7–13. Copy both runs' `transcript.jsonl`, `junit.xml` and `suite.rc` to the laptop (check them for secrets first): they are the fixtures for rows 12–13 in task 05.
8. Restore the clone before task 05: `git -C /var/lib/cloudtest/repo checkout -- . && git -C /var/lib/cloudtest/repo clean -fd` (removes the spike's uncommitted `scripts/e2e-ci.sh`, `test-results/` and any temporary `.claude/settings.json`; the venv lives outside the clone), then check out `dev-v2`.

## Runner contract
Tasks 05 (runner), 06 and 07 (server, fake runner) use this section.

- Call: `run-once.sh <run_dir> <sha>`. It writes nothing to stdout/stderr; its log goes to `<run_dir>/run.log`.
- Run directory: `<run_dir>/{meta.json, report.md, transcript.jsonl, claude.json, claude.err, junit.xml, suite.rc, run.log, artifacts/}` (`artifacts/` holds `test-results/` and `e2e/<folder>/screenshots/`).
- `meta.json` writes are merges (`jq '. + $patch'` to a tmp file, then `mv`). While the runner runs it is the only writer.
  - At creation (server, or the runner on the SSH path): `{id, project, sha, status: "queued", created_at}`.
  - Runner start: `{status: "running", started_at, claude_version}`.
  - Runner end: `{status, result, reason, finished_at, claude_exit, num_turns, duration_ms, passed, failed, skipped, blocked, suite_exit, agent_line_ok, fetch_ms, install_ms, claude_ms, tests_ms}` (`failed` includes errored tests; `tests_ms` from `junit.xml`; fields that do not apply are `null`).
  - Server: only O2 and O3, as `{status: "error", reason, finished_at}`.
- Runner exit codes: `0` done/pass · `1` done/fail · `2` error · `3` timeout · `75` busy (lock held; nothing created or changed). The CLI mirrors 0–3.

## Acceptance criteria
- [ ] `vps/prompt.md` and this file are committed in this repo. The target repo's `scripts/e2e-ci.sh`, `CLAUDE.md` Cloud E2E section (and failure-screenshot hook, if needed) are merged into `dev-v2`.
- [ ] `E2E_BASE_URL=http://localhost:3000 bash scripts/e2e-ci.sh` and `bash scripts/e2e-ci.sh -k x` both exit 64 without running pytest.
- [ ] In both hand runs, the agent's line 1 matches the regex and equals the line built from `junit.xml` per step 4, exactly one suite call is in the transcript, and `suite.rc` agrees with the counts (0 with failed = 0, 1 with failed > 0).
- [ ] The red run lists the broken test with the correct `file:line` and a screenshot path that exists in the clone.
- [ ] After step 8, `git -C /var/lib/cloudtest/repo status --porcelain` prints nothing.
