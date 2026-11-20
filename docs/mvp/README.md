# Cloud Test Agent — MVP Plan

Status: plan, final (review round 5) · Date: 2026-11-19
Source design: [../architecture/cloud-test-agent-architecture.md](../architecture/cloud-test-agent-architecture.md), flows in [../architecture/diagram/](../architecture/diagram/).

**How to use this plan.** Do the tasks below in number order (07 and 09 may run alongside 05, see §7). Each task file in `tasks/` has a goal, scope, numbered steps, acceptance criteria (ACs) and, for the risky ones, a stop condition: a task is done when every AC is ticked, and a stop condition means pause and change the design before writing more code. Tasks that discover facts write them to `docs/mvp/findings/NN-*.md`; later tasks read those notes. This README holds what the tasks share: the goal and demo (§1, §3), stack and config keys (§2), scope (§4–5), and risks (§6). Statuses, reasons and runner exit codes are defined once, in [task 04](tasks/04-prompt-and-report-contract.md).

### Task index

| Task | Title | Size | Depends on | Milestone |
|---|---|---|---|---|
| 00 | [Pre-flight: A3 answer and dev reachability](tasks/00-preflight.md) | S | none | A |
| 00b | [Local smoke test (laptop stands in for the VPS)](tasks/00b-local-smoke.md) | M | none | A (optional, before 01) |
| 01 | [VPS provisioning](tasks/01-vps-provisioning.md) | M | 00 | A |
| 02 | [Manual E2E run from VPS against dev](tasks/02-manual-e2e-from-vps.md) | M | 01 | A |
| 03 | [Claude headless auth spike](tasks/03-claude-headless-spike.md) | L | 01, 02 | A |
| 04 | [Run prompt and report contract](tasks/04-prompt-and-report-contract.md) | M | 03 | A |
| 05 | [Runner script `run-once.sh`](tasks/05-runner-script.md) | L (up to 2 days) | 04 | A |
| 06 | [SSH walking skeleton](tasks/06-ssh-walking-skeleton.md) | S | 05 | **A** (reached) |
| 07 | [API server with file-backed queue](tasks/07-api-server.md) | M | 04 (last AC needs 05) | B |
| 08 | [systemd service and network binding](tasks/08-systemd-and-network.md) | S | 05, 07 | B |
| 09 | [`cloudtest` CLI](tasks/09-cloudtest-cli.md) | M | 07 (real-service ACs need 08) | B |
| 10 | [Claude Code integration on laptop](tasks/10-claude-code-integration.md) | S | 08, 09 | B |
| 11 | [Demo and failure drills](tasks/11-demo-and-drills.md) | S (+ passive soak) | 08, 09, 10 | **B** (reached) |

Sizes: S ≤ 2 h, M ≈ half a day, L ≈ 1 day. Total: **7–8 working days**, plus about 2–3 days of soak waiting (task 03 → 08, task 11) that mostly overlaps other work.

## 1. MVP goal

Prove, end to end and with the least code, that:

> From the laptop, one command (run by hand or by Claude Code as a background command) sends the current commit to a VPS. There, a headless `claude -p` agent runs the repo's own Playwright E2E suite against the dev environment and returns a structured PASS/FAIL report. The laptop gets the report back even if it disconnected while the run was going.

The MVP proves the idea can work. It is not the product. Anything that does not help prove that is deferred.

## 2. Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Language (server + CLI) | **Node.js 22 LTS, plain ESM JavaScript, no npm dependencies** (`node:http`, `node:fs`, `node:child_process`, `fetch`) | Node must be on the VPS anyway for Playwright, and the laptop already has it. With no dependencies there is no build step and no lockfile: two programs (`server.mjs`, `cloudtest.mjs`) plus one shell runner, and a few helper scripts. Python/FastAPI would add a second runtime for no gain. |
| Runner (one test run) | **Bash script `run-once.sh`**, with classification in a small Node helper `classify.mjs` | Its work is git, `npm ci`, `timeout`, and starting `claude`, which is shell work. It can be run by hand (task 05), over SSH (task 06), and by the server (task 07). One code path covers all three. Parsing the transcript and `pw.json` is not shell work: `classify.mjs` does it and is tested on the laptop against fixtures (task 05). |
| Run store / queue | **Files: `/var/lib/cloudtest/runs/<id>/{meta.json, report.md, transcript.jsonl, claude.json, claude.err, pw.json, run.log, artifacts/test-results/}`** | One user, one run at a time. You can inspect it with `ls`/`cat`, and it needs no schema or migrations. SQLite comes in with the dashboard (out of scope). `pw.json` (Playwright's JSON reporter) is the authority for counts; `transcript.jsonl` (claude `stream-json`) is the evidence of what the agent did; `claude.json` is its final `result` event. |
| Queue / worker | Serial in-memory queue inside the server process. On startup the server rescans the run dirs: `queued` goes back into the queue, and a stale `running` has its worktree removed and becomes `error: worker restarted` (systemd's cgroup kill has already stopped its processes) | This fixes the "stuck in running" gap from flow 1b without a separate worker process. |
| Process manager | **systemd** service under a dedicated user `cloudtest` | It restarts on crash, keeps logs in journald, and needs no Docker. The Claude auth lives with that user. |
| Network access | **Tailscale**: the server binds to the tailnet IP only, and we use a static bearer token | No public port, no TLS work, no Cloudflare setup. Fallback: `ssh -L` tunnel. |
| Secrets | Files owned `root:cloudtest`, mode `0640`: `/etc/cloudtest/github-token`, `/etc/cloudtest/project.env`, `/etc/cloudtest/api-token` (and `/etc/cloudtest/claude-token` if task 03 picks `setup-token`) | The VPS has one service user and Claude credentials are plaintext for that user anyway, so encrypting files at rest adds no real protection at MVP stage. Deferred along with the dashboard. See R2 for what the test process can read. |
| Project config | **One project**, set in `/etc/cloudtest/config.env` (keys in §2.1) | Multi-project support is out of scope. The API still takes `project` and returns 404 on a mismatch, so the contract does not change later. |
| Node and Claude Code install | NodeSource Node 22 (`/usr/bin/node`); Claude Code via `sudo npm i -g @anthropic-ai/claude-code@<x.y.z>` (`/usr/bin/claude`, root-owned, so the service user cannot auto-update it); `--model` pinned; version recorded in `meta.json` | One install path, so the fixed `PATH=/usr/local/bin:/usr/bin:/bin` and `ExecStart=/usr/bin/node` hold. Flags and JSON fields must not change between the spike and the demo; usage must be comparable across runs. |

### 2.1 Config keys

`/etc/cloudtest/config.env` is read by the runner (task 05) and the server (task 07, via the unit's `EnvironmentFile`, task 08). This is the only list of keys.

Rules: the file is plain `KEY=value` lines (no `export`, no spaces around `=`), valid for both systemd and bash. The runner sources it at every start, so **the file wins over the inherited environment**, and the runner applies defaults after sourcing. To change a runner key, edit the file; no restart is needed. The server reads its keys from its environment once at start: changing a server key needs `systemctl restart cloudtest`.

| Key | Default | Used by |
|---|---|---|
| `PROJECT` | required | runner (meta), server (404 on mismatch) |
| `TIMEOUT_MIN` | `20` | runner: cap on claude + suite only. A run's wall time is at most 2 (fetch) + 15 (install) + `TIMEOUT_MIN` min. |
| `MAX_TURNS` | `30` | runner |
| `MODEL` | required (pinned) | runner |
| `BIND` | required (tailnet IP; `0.0.0.0` refused) | server |
| `PORT` | `8787` | server |
| `RUNNER` | `/opt/cloudtest/vps/run-once.sh` | server (tests set `vps/fake-run.sh`) |
| `RUNS_DIR` | `/var/lib/cloudtest/runs` | server (tests set a temp dir, task 07) |
| `API_TOKEN_FILE` | `/etc/cloudtest/api-token` | server (tests set a temp file, task 07) |

The repo URL is the clone's `origin` (task 02); it is not a key.

## 3. Success criteria (demo script)

The MVP is done when all of the following work on the real target repo and the real dev environment, and the results are written in `docs/mvp/findings/11-demo.md` (task 11).

1. **Green run.** On the laptop, in the target repo: commit a trivial change, then run `cloudtest run <project>`. It prints `run_id`, then status updates, then `sha <sha>` and the report beginning `RESULT: PASS (N passed, 0 failed)`, and exits `0`. The printed `sha` matches `git rev-parse HEAD`.
2. **Red run.** Commit a deliberately broken assertion and run again. The report shows `RESULT: FAIL`, the failing test with `file:line`, the error, and a screenshot path that exists under `<run_dir>/artifacts/` on the VPS. The CLI exits `1`. The counts equal `pw.json` (passed = `expected` + `flaky`, failed = `unexpected`).
3. **Disconnect survival.** Start a run, kill the CLI (Ctrl-C) or sleep the laptop, wait, then run `cloudtest wait <run_id>`. It gets the finished report.
4. **Auth failure is explicit.** Make the Claude auth invalid with the method chosen in task 03 (move `~cloudtest/.claude/.credentials.json` aside, or put an invalid value in the long-lived token file). The run ends `status=error`, the reason is `claude auth failed`, and the CLI exits `2`. Restore afterwards.
5. **Timeout is explicit.** Run the [timeout drill from task 05](tasks/05-runner-script.md) (`TIMEOUT_MIN=2` in the config file, a throwaway spec that keeps Chromium open for 10 min). The run ends `status=timeout`, the leak check from task 05 is empty afterwards, and the CLI exits `3`.
6. **Agent-driven.** In Claude Code on the laptop, ask for a **test-code** change ("add an E2E assertion for heading X and verify it", seeded so the first run is red). The dev agent starts `cloudtest run` as a background command (`run_in_background: true` in the laptop transcript), reads the FAIL report, fixes the test, and the second run passes (the `CLAUDE.local.md` rule is followed without a reminder). The demo exercises test-code changes only: under A3, an app-code change on the branch does not change what dev serves.
7. **Repeatability.** Do 5 consecutive green runs with no manual work on the VPS. Record the median wall time and its split as recorded in `meta.json`: fetch, install (`npm ci` + browser check), tests (`pw.json` duration), Claude overhead (claude time − test time).

## 4. In scope (basic features)

- Laptop CLI `cloudtest` with commands `run <project>` and `wait <run_id>`. It force-pushes `HEAD:refs/heads/agent/test`, POSTs the run, polls every 5 s within a deadline, prints the report, and uses defined exit codes.
- VPS HTTP API: `POST /api/runs` (202, and the same SHA already queued or running returns the existing run), `GET /api/runs/:id`, and `GET /healthz`.
- Serial runner: fetch by SHA with a token via `GIT_ASKPASS` (with timeout), a clean worktree per run, `npm ci` + browser check in the runner, `timeout` plus a kill of every process under the run's worktree and any Playwright browser, `claude -p` with the tools `Read/Grep/Glob/Bash` where the only allowed Bash command is `npm run e2e:ci`, `--max-turns`, and a clean `env -i` environment.
- A fixed run prompt and a machine-parsable report contract (first line `RESULT: PASS|FAIL|ERROR ...`); pass/fail and counts come from `pw.json` and the suite command's exit status, the runner writes line 1, the agent writes the diagnosis.
- Statuses `queued`, `running`, `done` (pass/fail), `error` (with a reason), `timeout`. The single list of conditions and reasons is the classification table in [task 04](tasks/04-prompt-and-report-contract.md).
- A laptop-only `CLAUDE.local.md` rule in the target repo so the dev agent uses `cloudtest` instead of running tests locally.

## 5. Explicitly out of scope (and why)

| Deferred | Why it can wait |
|---|---|
| Dashboard, project CRUD, run history UI | Proves nothing about feasibility. `ls` and `cat` on the run dirs are the run history. |
| Multi-project | Only one repo is needed to prove the idea. The API shape already allows more later. |
| Encryption at rest | See secrets row in §2. Plain files have the same trust level as the existing Claude credentials. |
| SQLite | The file store is enough for one user and one run at a time. |
| Artifact download over HTTP | The report gives paths under the printed run dir, and `scp` is enough for the demo. Add `GET /api/runs/:id/artifacts/*` right after the MVP if screenshots turn out to matter in practice. |
| Docker per run, sandboxing, separate test user | It is our own repo on our own VPS. A fresh worktree per run is enough isolation for now (see R2). |
| Deploying the branch to dev before testing | **MVP assumption:** tests target whatever dev currently serves (see A3). |
| SSE/webhooks/MCP wrapper, cancel endpoint, auto-retry, `status` command, artifact retention job | Polling with `wait` covers the flow. Cleanup is a manual `rm` for now; task 11 measures disk growth. |
| Failure-only Claude mode (run Playwright directly, call Claude only on red) | A good cost optimisation later. The MVP has to prove that the Claude-driven path works. |

## 6. Key assumptions and risks

| # | Assumption / risk | Impact if wrong | De-risked by |
|---|---|---|---|
| A1 | **The VPS can reach the dev environment** (no VPN or IP allow-list, or the VPS IP can be added to one) | The project is blocked or needs a VPN client on the VPS | Task 00 (`curl` from the VPS), confirmed by the full suite run in task 02 |
| A2 | **`claude -p` runs headless from systemd** under the `cloudtest` user, using the subscription (login or `setup-token`), with no TTY and no prompts, and auth survives for days | Runs hang or fail, or need frequent manual re-login | Task 01 (hello-world under `systemd-run`), task 03 (spike, auth method, 26 h soak timer), task 08 (service), task 11 (≥ 24 h soak) |
| A3 | The tests are meaningful against what dev currently serves, so no deploy of the branch is needed | Green/red reflects dev, not my commit. The MVP then proves the plumbing only, and a deploy step becomes the next task. The demo uses test-code changes either way. | Answered in writing in task 00 |
| A4 | The repo's `CLAUDE.md` says how to run E2E (`npm run e2e:ci`, base URL env) | The agent guesses or wanders and burns turns | Task 04 commits the script and instructions; task 03 checks `CLAUDE.md` still loads with the chosen settings flags |
| A5 | The agent's report reflects reality and does not hallucinate pass/fail | A false green is the worst failure mode | Task 04: `pw.json` plus the suite command's exit status decide pass/fail; the runner writes line 1 and records whether the agent's line agreed (`agent_line_ok`); exactly one executed suite run per transcript; missing `pw.json` or Playwright errors are an error |
| A6 | The VPS has enough resources for Chromium plus the suite (target 4 vCPU / 8 GB) | Flaky timeouts on the VPS | Task 01 measures, task 02 records peak RSS |
| A7 | Subscription usage per run is acceptable | Hitting rate limits mid-day | Task 03 records turns/usage per run; usage-limit errors show up as `claude failed: <message>`; task 11 totals all runs |
| R1 | A repo-level `.claude/settings.json` or hooks in the target repo could widen the agent's permissions | The agent could edit files | Task 03 checks how repo settings interact with the flags (`--setting-sources`). The worktree is thrown away afterwards anyway. |
| R2 | **Accepted MVP risk:** `npm ci` and the Playwright tests execute repo code as `cloudtest`, which can read `/etc/cloudtest/*` and the Claude credentials. This is weaker than architecture §8 ("token never passed to the test process"): the token is kept out of the environment, not out of reach. | A malicious dependency or test could read the read-only single-repo PAT, the API token and the Claude auth | Own repo, read-only single-repo PAT, tailnet-only API. The agent itself has no allow rule for read tools and is denied `Read(//etc/cloudtest/**)` and `Read(~/.claude/**)`, which also cover `Grep`/`Glob` (task 03). A separate run user is the post-MVP fix. |

## 7. Order, dependencies and estimates

The task index is at the top of this file. Order is chosen to remove the biggest unknowns first. **Milestone A** (after task 06) already proves feasibility over SSH. **Milestone B** (after task 11) is the async, disconnect-safe MVP.

| Task | Unknown it removes |
|---|---|
| 00 | **A3**, **A1** (first look) |
| 01 | Base machine, Tailscale, sizing, A2 hello-world |
| 02 | **A1** in full, A6, baseline |
| 03 | **A2 headless auth**, R1, A7 |
| 04 | A4, A5 |
| 05 | Fetch-by-SHA, install, timeout kill, classification |
| 06 | End-to-end feasibility |
| 07 | Async contract, restart recovery |
| 08 | A2 under systemd, reachability of the API |
| 09 | Polling, resume, exit codes |
| 10 | Dev agent uses the background command |
| 11 | Success criteria §3 |

Dependency graph:

```
00 ─► 01 ─► 02 ─► 03 ─► 04 ─┬─► 05 ─┬─► 06                    (Milestone A)
                            │       └──────────┐
                            └─► 07 ─┬────────► 08 ─┐
                                    └─► 09 ────────┴─► 10 ─► 11   (Milestone B)
```

07 and 09 only need the runner contract (`meta.json` fields, runner exit codes) from task 04 (both are tested with the fake runner), so they can run in parallel with 05.

Estimates: S ≤ 2 h, M ≈ half a day, L ≈ 1 day; task 05 is L but up to 2 days. The sizes add up to about 6.75 days; with slack the total is **7–8 working days**. Calendar time is longer: the 26 h soak (task 03 → 08) and the 24–48 h soak (task 11) add about 2–3 days of waiting, most of which overlaps other tasks. Tasks 00, 02 and 03 can each end the project early. If any fails, stop and change the design before writing code.

Spike tasks (00, 01, 02, 03), task 06 and the demo (11) write short notes to `docs/mvp/findings/NN-*.md`. Later tasks use those notes as input.

## Review responses

One line per review item: round · item · disposition. Row numbers in entries before R3 refer to the classification table as it was in that round; the current numbering is in task 04.

- R1 · 1 (blocker, transcript) · fixed: `stream-json --verbose` → `transcript.jsonl`, `claude.json` = result event; `pw.json` is the count source (§2, §3.2, A5, tasks 03/04/05/10).
- R1 · 2 (blocker, false-green) · fixed: task 04 table with `pw.json` authority, count mapping, rows for missing `pw.json`, no tests, mismatch, `is_error`/catch-all, usage limit, suite-run count ≠ 1.
- R1 · 3 (blocker, kill) · fixed: background `setsid … timeout`, `pkill -s $pid` + Playwright backstop, 124/137 → timeout, fetch under `timeout 120`, §3.5 reworded (task 05).
- R1 · 4 (blocker, A3 demo) · fixed: test-code scenario in task 10 and §3.6.
- R1 · 5 (A3 late) · fixed: new task 00 pre-flight.
- R1 · 6 (token refresh) · fixed: `setup-token` evaluated in task 03, 26 h soak timer started there, auth drill follows the chosen method.
- R1 · 7 (permissions) · fixed: `--tools`, `dontAsk`, `--strict-mcp-config`, single `Bash(npm run e2e:ci)`, denied-call count, flag verification, CLAUDE.md-load check (task 03).
- R1 · 8 (secrets readable) · fixed by stating it as accepted risk R2 plus Read deny rules; separate run user deferred.
- R1 · 9 (state handling) · fixed: jq merge, EXIT trap, `runner_pid`/`claude_sid` in meta, server post-exit rule, recovery kills and `rm -rf wt` (tasks 05/07/08).
- R1 · 10 (timing split) · fixed: `npm ci` moved into the runner; `fetch_ms`, `install_ms`, `claude_ms`, `tests_ms` recorded.
- R1 · 11 (boot bind) · fixed: `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0`, `DISABLE_AUTOUPDATER=1` (task 08).
- R1 · 12 (git token) · fixed: `grep -Ec`, absolute askpass with Username/Password answers, `credential.helper=`, `GIT_TERMINAL_PROMPT=0`, "normal clone" wording (tasks 02/05).
- R1 · 13 (screenshot paths) · fixed: paths resolve under `<run_dir>/artifacts/`, `test -f` AC, screenshot config check, `playwright-report/` copy dropped.
- R1 · 14 (conflicting CLAUDE.md) · fixed: laptop rule in `CLAUDE.local.md`, prompt line for the VPS agent, task 04 checks re-run in task 10.
- R1 · 15 (id/healthz) · fixed: id regex, `/healthz` returns `{ok}` only.
- R1 · 16 (version pin) · fixed: pinned version, auto-update off, version in meta, `--model` pinned.
- R1 · 17 (SHA in report) · fixed: CLI prints `sha` before the report.
- R1 · 18 (`CI`, env loading) · fixed: `CI=1` in baseline and runner, `set -a; .` inside a `bash -c` wrapper.
- R1 · 19 (SSH, deploy) · fixed: SSH access in task 01, deploy and self-locating paths in task 05.
- R1 · 20 (estimates) · fixed: 03 = L, 04 = M, 05 = L, total 6–7 days (05 not split).
- R1 · 21 (dependencies) · fixed: 07 after 04, 09 after 07, hello-world headless check in task 01.
- R1 · 22 (scope) · fixed: cut `status`, backoff curve, `ALLOW_PUBLIC`, `queue_length`/`running_id`; exit codes 0–5 kept (2 vs 3 is cheap and separates the drills).
- R1 · 23 (force-push race, CI) · fixed: `sha no longer on agent/test` reason and known limit (task 09), CI exclusion in task 04.
- R1 · 24 (browsers, disk) · fixed: runner runs `playwright install chromium`, `--no-session-persistence`, disk use recorded in task 11.
- R1 · 25 (naming) · fixed: single reason list in task 04, README links to it, rename vs architecture §7 noted.
- R1 · 3 (kill/timeout, re-opened in R2) · fixed via R2 · 2–4: 137 split by elapsed time, kill by worktree path + `ms-playwright`, cleanup moved into the trap.
- R1 · 8 (secrets readable, re-opened in R2) · fixed via R2 · 5: no read-tool allow rules, `//`-absolute deny rules; R2 stays an accepted risk for repo code.
- R1 · 2 (false green, re-opened in R2) · fixed via R2 · 6: `pw.json` `errors` and the suite call's exit status are checked; the runner writes line 1.
- R1 · 14 (conflicting CLAUDE.md, re-opened in R2) · fixed via R2 · 7: dirty check ignores untracked files, local files in `.git/info/exclude`, `ls-tree` AC.
- R2 · 1 (blocker, Bash tool timeout) · fixed: `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` = `TIMEOUT_MIN` in ms in `env -i` (tasks 03/05), foreground line in prompt, >120 s AC in task 03.
- R2 · 2 (137 ≠ timeout) · fixed: row 1 = 124, or 137 with claude time ≥ `TIMEOUT_MIN`; other 137 → row 7 `claude failed: killed (signal 9)` (tasks 04/05).
- R2 · 3 (leak check vacuous) · fixed: `kill_run_procs` kills by cwd/cmdline under `<run_dir>/wt` plus `ms-playwright` and logs what it found; session kill dropped; one leak check reused by task 05, task 08, §3.5; drill uses a sleeping spec with `TIMEOUT_MIN=2`.
- R2 · 4 (flock fd, trap) · fixed: `exec 9>lock; flock -n 9`, children started with `9>&-`, HUP/TERM trapped, `on_exit` kills then removes the worktree; SIGTERM AC in task 05. Changed from the review: the SSH-drop AC (task 06) expects the run to finish, not to be killed, because the runner writes nothing to stdout and plain `ssh` sends no hang-up.
- R2 · 5 (deny rules) · fixed: only `Bash(npm run e2e:ci)` allowed, deny rules `Read(//etc/cloudtest/**)` and `Read(~/.claude/**)` in task 03 and R2, AC covers Read/Grep/Glob on both files plus CLAUDE.md still readable.
- R2 · 6 (`pw.json` not enough) · fixed: rows 11 (`errors` non-empty) and 13 (suite call non-zero with `unexpected` = 0); row 9 counts only executed (non-denied) calls; task 03 step 6 records both signatures.
- R2 · 7 (untracked files block run) · fixed: `--untracked-files=no` (task 09), `.git/info/exclude`, `ls-tree` AC and `CLAUDE.local.md` load check with `@`-import fallback (task 10).
- R2 · 8 (server kill path) · fixed by cutting it: recovery = remove `wt`, prune, `worker restarted`, re-queue; `runner_pid`/`claude_sid` dropped from meta; task 07 AC 2 asserts the state transition only, task 08 AC 3 keeps the process check.
- R2 · 9 (install options) · fixed: NodeSource Node + `sudo npm i -g` Claude Code only (README §2, task 01); `nvm` and native installer removed.
- R2 · 10 (config drift) · fixed: README §2.1 single key list with defaults (`TIMEOUT_MIN=20`, `PORT=8787`, `RUNNER`, `BRANCH`), `REPO_URL` dropped, runner uses `$BRANCH`, wall-time bound stated; laptop `branch` must equal `BRANCH`.
- R2 · 11 (table structure, contract location) · fixed: runner table (rows 1–15, first match wins) split from out-of-band rows O1–O3; "Runner contract" section (meta fields, exit codes) moved into task 04, tasks 05/07 link to it.
- R2 · 12 (clone exceptions) · fixed: task 02 names tasks 02–04 as exceptions, task 04 AC says "in the clone", task 04 step 8 cleans the clone with an AC.
- R2 · 13 (rows 6 and 14) · fixed: usage-limit row folded into row 7; `report mismatch` removed as an error: the runner writes line 1 from `pw.json` and records `agent_line_ok`, whose rate task 11 records (row "unparsable report" dropped for the same reason).
- R2 · 14 ("keeps working", exit 4) · fixed: AC checks `run_in_background: true` in the laptop transcript; exit 4 added to the rule; §3.6 reworded.
- R2 · 15 (traversal test, 200 body) · fixed: `curl --path-as-is` plus `%2e%2e` variant; `200` has the `202` shape.
- R2 · 16 (hello-world, soak) · fixed: AC uses `is_error == false` + exit 0; soak writes via `StandardOutput=file:`, "do not reboot" note, auth method stated; soak read moved to task 08 (before its reboot step).
- R2 · 17 (wording) · fixed: "two programs plus one shell runner", `findings/11-demo.md`, "if AC 2 still shows leaks", unit split into `[Unit]`/`[Service]`/`[Install]` with `Wants=network-online.target`.
- R3 · 1 (classifier in bash) · fixed: classification moved to `vps/classify.mjs` (rows 3–13), runner keeps rows 1–2 and O1; one fixture per row under `vps/fixtures/`, AC `node vps/classify.test.mjs` prints `11/11 rows ok` (tasks 04/05, README §2).
- R3 · 2 (timeout drill spec) · fixed: exact `test.setTimeout(15 min)` spec and `globalTimeout` note, defined once in task 05 ("Timeout drill"); README §3.5 and task 11 link to it.
- R3 · 3 (claude command) · fixed: task 05 step 9 builds `ce`/`wrap`/`cmd` arrays, the inner `bash -c` only loads `project.env` and the optional token file then `exec "$@"`; `setsid` dropped.
- R3 · 4 (config precedence) · fixed: README §2.1 rule (file wins, runner sources it each start and applies defaults after, server keys need a restart, plain `KEY=value`); drills say "edit the file, run, restore".
- R3 · 5 (fake-runner setup) · fixed: `RUNS_DIR`/`API_TOKEN_FILE` keys; `smoke.sh` runs on the laptop with `127.0.0.1:18787` and a temp token; fake outcome read from `$RUNS_DIR/fake.env` (no restarts); `FAKE_RESULT=timeout`; task 09 ACs for exit 3 and exit 5 (`--deadline 0.1`).
- R3 · 6 (git gc holds lock) · fixed: every child goes through `run()` with `9>&-`; fetch with `gc.auto=0`, `maintenance.auto=false`.
- R3 · 7 (dir before lock) · fixed: lock first, then run dir and meta, then output redirect; exit 75 creates nothing (task 05 step 3, task 04 exit codes, AC).
- R3 · 8 (600 s limit, background) · fixed: `sleep 660` stand-in; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in tasks 03/05 with a verify step; prompt line kept.
- R3 · 9 (vacuous R1 test) · fixed: repo `{"allow": ["Bash"]}` plus `touch x`; `--setting-sources user` if it widens, then CLAUDE.md re-check.
- R3 · 10 (O1/O2 overlap) · fixed: O2 = meta still `queued`/`running` after exit only; exit-code clause removed from task 07.
- R3 · 11 (table wording, row 8) · fixed: "before claude" block (rows 1–2) and "after claude" block (rows 3–13); row 3 names the claude `timeout` wrapper; agent-`ERROR` row cut, agent line never decides status. Rows renumbered; all references updated.
- R3 · 12 (report body undefined) · fixed: task 04 `report.md` rule (match → drop agent line 1, no match → keep all, no text → line 1 only; written for rows 1–13; CLI prints `reason` when `report_md` is null, task 09).
- R3 · 13 (fetch fallback, `BRANCH`) · fixed by cutting: single `fetch origin <sha>`, one fetch row, `BRANCH` removed from §2.1; `branch` stays in the laptop config only; task 09 known-limit wording updated.
- R3 · 14 (push refspec) · fixed: `HEAD:refs/heads/agent/test` in task 06, task 09, README §4.
- R3 · 15 (TERM during install) · fixed: fetch and install also run as `cmd & wait $!` via `run()`; AC sends TERM during install and during claude.
- R3 · 16 (two auth sources) · fixed: with `setup-token`, `cloudtest` is logged out; file method records a real 401 signature if producible; unmatched signatures land in row 6 (task 03 step 7).
- R3 · 17 (guessable commands) · fixed: `systemd-run` with `WorkingDirectory`/`HOME`/`PATH` properties (task 03), task 10 AC grep on `~/.claude/projects/<repo-slug>/*.jsonl`, run ids in UTC (tasks 06/07).
- R3 · scope (optional cuts) · `flaky` meta field cut (in `pw.json`; counted in `passed`). `--deadline` kept, rejected as a cut: the exit-5 AC from item 5 needs it and it is one flag.
- R4 · 1 (spike `setsid`, Bash limit) · fixed: `setsid --wait` in task 03 step 2 and AC 1; spike-only `BASH_*_TIMEOUT_MS` = 660 s + task 02 suite time + margin.
- R4 · 2 (SSH-drop AC too weak) · fixed: task 06 AC 3 requires `done` with the same result as an undisturbed run; task 01 step 5 says switch to OpenSSH if Tailscale SSH fails it.
- R4 · 3 (SSH path vs service) · fixed by a usage rule, no code: task 06 scope and task 08 say use `cloudtest-ssh` only while the service is idle and never restart the service during an SSH run.
- R4 · 4 (fake runner `wt/`, laptop `jq`) · fixed: fake runner creates `wt/` at start and removes it at a normal end (`exit9` leaves it); `jq` on the laptop stated in task 07 scope.
- R4 · 5 (`time`, `rsync`) · fixed: added to task 01 step 2. Also from the sweep: task 01 step 3 now makes `/var/lib/cloudtest` itself `cloudtest`-owned, since the runner creates `run.lock` there.
- R4 · 6 (leak check self-match) · fixed: task 05 leak-check paragraph says run it from an interactive shell or as root, not as a one-line `ssh` command.
- R4 · 7 (old row numbers in log) · fixed: note at the top of this log.
- R4 · 8 (estimate) · fixed: task 05 = "L, up to 2 days" with a suggested internal order; task 01 raised to M; total 7–8 working days plus 2–3 days of mostly overlapping soak time (top index, §7).
- R5 · sweep · README now opens with a "how to use this plan" paragraph and a task index (task, title, size, depends on, milestone); §7 keeps the graph, unknowns and estimate. Task numbers, dependencies, config keys, statuses, exit codes, row numbers and file names re-checked across README and tasks 00–11.
