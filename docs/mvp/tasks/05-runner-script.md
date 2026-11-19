# 05 — Runner script `run-once.sh`

**Estimate:** L, up to 2 days (runner, classifier, 11 fixtures, and 6 ACs that each need a real run of several minutes) · **Depends on:** 04

Suggested order, so progress shows early: `classify.mjs` and its fixtures on the laptop first (AC 1), then the green and red paths (AC 2), then the failure, kill, TERM, timeout and busy drills (ACs 3–8).

## Goal
One script runs exactly one test run for one SHA, from start to finish, and leaves a complete run directory behind. The SSH skeleton (06) and the API server (07) both call it unchanged.

## Scope
- In: `vps/run-once.sh <run_dir> <sha>`, `vps/classify.mjs` with its fixtures and test, deployment of `vps/` to `/opt/cloudtest/vps`. The script fetches by SHA, creates a fresh worktree, installs, runs `timeout` + `claude -p`, hands the result to `classify.mjs` (task 04 tables), writes the files, and cleans up.
- Out: queueing across processes (the server serialises; `flock` covers the SSH path), HTTP.

## Contract
Call, run directory, `meta.json` fields and exit codes: see [task 04, Runner contract](04-prompt-and-report-contract.md#runner-contract). `transcript.jsonl` is claude's stream-json stdout, `claude.err` its stderr, `claude.json` its `type=result` event (extracted with `jq`), `run.log` the runner's own log.

## Steps
1. Deploy: `rsync` (or `git clone` this repo) to `/opt/cloudtest`. The script finds its siblings via `here=$(dirname "$(readlink -f "$0")")` and uses only absolute paths (`$here/askpass.sh`, `$here/prompt.md`, `$here/classify.mjs`).
2. Config: `set -a; . /etc/cloudtest/config.env; set +a`, then apply defaults (`: "${TIMEOUT_MIN:=20}" "${MAX_TURNS:=30}"`). The file wins over the inherited environment (README §2.1).
3. Lock first: `exec 9>/var/lib/cloudtest/run.lock; flock -n 9 || exit 75`. The lock file is outside the run dir, so a busy call creates nothing. Only then create `<run_dir>` and the creation-time `meta.json` if they do not exist (SSH path), and send all own output to `run.log` (`exec >>"$run_dir/run.log" 2>&1`), so a dropped SSH session cannot kill the runner with SIGPIPE.
4. Child processes: every child is started through one helper, `run() { "$@" 9>&- & wait $!; }`. Closing fd 9 means no leaked process (including a detached `git gc`) can hold the lock after the runner exits; running in the background with `wait` means a TERM is handled at once in every phase, not after the current command ends.
5. Merge `{status: "running", started_at, claude_version}`. Install `trap on_exit EXIT` and `trap 'exit 129' HUP; trap 'exit 143' TERM INT` (so a signal also runs `on_exit`). `on_exit`, in this order: `kill_run_procs` (step 10), `git worktree remove --force wt` (falling back to `rm -rf` + `git worktree prune`), and, if no final status was written, merge `error / runner crashed` (task 04 row O1).
6. Fetch, in `/var/lib/cloudtest/repo`: `run env GIT_ASKPASS=$here/askpass.sh GIT_TERMINAL_PROMPT=0 timeout 120 git -c credential.helper= -c gc.auto=0 -c maintenance.auto=false fetch origin <sha>`. Failure → task 04 row 1. Record `fetch_ms`. The token is never in any process environment.
7. Worktree: `git worktree add --detach <run_dir>/wt <sha>`. Leave `node_modules` uncached for the MVP.
8. Install, with the clean env `ce` from step 9: `run "${ce[@]}" timeout 10m npm ci`, then `run "${ce[@]}" timeout 5m npx playwright install chromium` (no `--with-deps`, no root; a no-op when the browser version is current). Failure → row 2. Record `install_ms`.
9. Run claude. The command is built as arrays in the runner; the inner `bash -c` only loads the secrets and `exec`s its arguments:
   ```
   ms=$((TIMEOUT_MIN*60000))
   ce=(env -i -C "$run_dir/wt" HOME=/home/cloudtest PATH=/usr/local/bin:/usr/bin:/bin CI=1
       DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
       BASH_DEFAULT_TIMEOUT_MS=$ms BASH_MAX_TIMEOUT_MS=$ms PLAYWRIGHT_JSON_OUTPUT_NAME="$run_dir/pw.json")
   wrap=(bash -c 'set -a; . /etc/cloudtest/project.env
         if [ -r /etc/cloudtest/claude-token ]; then CLAUDE_CODE_OAUTH_TOKEN=$(cat /etc/cloudtest/claude-token); fi
         set +a; exec "$@"' _)
   cmd=(timeout --kill-after=30s "${TIMEOUT_MIN}m" claude -p "$(cat "$here/prompt.md")"
        --output-format stream-json --verbose --model "$MODEL" --max-turns "$MAX_TURNS"
        --tools "Read,Grep,Glob,Bash" --allowedTools "Bash(npm run e2e:ci)"
        --disallowedTools "Read(//etc/cloudtest/**)" "Read(~/.claude/**)"
        --permission-mode dontAsk --strict-mcp-config --no-session-persistence)
        # plus any flag task 03 settled on (e.g. --setting-sources user); its findings are the reference
   run "${ce[@]}" "${wrap[@]}" "${cmd[@]}" </dev/null >"$run_dir/transcript.jsonl" 2>"$run_dir/claude.err"; rc=$?
   ```
   `env -i` guarantees there is no `ANTHROPIC_API_KEY` and no GitHub token; `-C` keeps the runner's own cwd outside `wt/` (step 10 kills by that path); `set -a; .` loads `project.env` without word-splitting; the `BASH_*_TIMEOUT_MS` values and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` stop Claude Code's own Bash tool from cutting off or backgrounding the suite (task 03). There is no `setsid`: stdin is `/dev/null` and none of the three call paths has a TTY. Record `claude_ms`; row 3 uses it.
10. `kill_run_procs` (called right after `wait`, and again from `on_exit`): list every `cloudtest` process other than `$$` whose cwd or command line is under `$run_dir/wt`, or whose command line contains `ms-playwright`; write the list to `run.log`; `kill -KILL` them; repeat once after 1 s. Claude's Bash tool starts commands in their own session, so a session kill would miss the Playwright tree; every descendant carries the worktree path in its cwd or command line. This is safe because runs are serial. If AC 3 still shows leaks, switch to `systemd-run --user --scope` per run (cgroup kill).
11. Classify: extract `claude.json` (`jq -c 'select(.type=="result")'`), then `node $here/classify.mjs --transcript … --stderr claude.err --pw pw.json --claude-exit $rc --claude-ms … --timeout-min $TIMEOUT_MIN --report report.md`. It applies task 04 rows 3–13, writes `report.md` (task 04 step 6 rules), and prints one JSON object (`status`, `result`, `reason`, `passed`, `failed`, `num_turns`, `duration_ms`, `agent_line_ok`) that the runner merges into `meta.json` with the timings. For rows 1–2 the runner writes `report.md` (line 1 only) and the meta itself.
12. Copy `wt/test-results/` to `<run_dir>/artifacts/test-results/` if it exists. Exit with the code from the runner contract; `on_exit` removes the worktree.
13. Fixtures: `vps/fixtures/<row>-<slug>/` holds `transcript.jsonl`, `claude.err`, `pw.json` (if any), `args.json` (exit, ms, timeout) and `expected.json` (`status`, `result`, `reason`), one directory per row 3–13. Rows 4, 5, 12, 13 use the real transcripts from tasks 03–04; the rest are hand-edited copies. `vps/classify.test.mjs` runs `classify.mjs` on each and compares.

**Leak check** (used by ACs 3 and 6, task 08 and README §3.5), run from an interactive shell on the VPS (as `cloudtest`) or as root, right after the run ends. Do not send it as one `ssh host '…'` line as `cloudtest`: the remote `bash -c` then has the pattern in its own command line and `pgrep` reports it as a leak. `ls -l /proc/*/cwd 2>/dev/null | grep -c "<run_dir>/wt"` prints 0, and `pgrep -u cloudtest -f "ms-playwright|<run_dir>/wt"` prints nothing.

**Timeout drill** (used by AC 3 and README §3.5): set `TIMEOUT_MIN=2` in `/etc/cloudtest/config.env` (no restart needed, README §2.1), run a throwaway commit that adds this spec, then restore the file:
```
test('hang', async ({ page }) => { test.setTimeout(15 * 60_000); await page.goto(process.env.BASE_URL); await page.waitForTimeout(10 * 60_000); });
```
`test.setTimeout` overrides the per-test timeout. If the Playwright config sets a `globalTimeout` under 2 min in CI mode, raise it in the same throwaway commit.

## Acceptance criteria
- [ ] On the laptop, `node vps/classify.test.mjs` prints `11/11 rows ok`.
- [ ] Running `run-once.sh` by hand on a green SHA gives status `done`, result `pass`, exit 0. On the red SHA it gives `fail`, exit 1, and every `screenshot:` path in `report.md` passes `test -f <run_dir>/artifacts/<path>`.
- [ ] Timeout drill (above): status `timeout`, exit 3, `run.log` lists the Chromium processes `kill_run_procs` found, and the leak check is clean right after the script exits.
- [ ] With auth broken as chosen in task 03 (credentials file moved aside, or an invalid token): status `error`, reason `claude auth failed`, exit 2.
- [ ] With a nonexistent SHA: status `error`, reason starting `fetch failed`, exit 2. `kill -9` of the runner's claude mid-run gives `error / claude failed: killed (signal 9)` (row 6), not `timeout` or `running`.
- [ ] `kill -TERM` of the runner during install and again during the claude phase (what a systemd stop or a hang-up sends): each time, within 10 s the leak check is clean, the worktree is gone, meta is `error / runner crashed`, and the next run starts without exit 75.
- [ ] `grep -r "$(cat /etc/cloudtest/github-token)" <run_dir>` finds nothing. The worktree is gone after every run, including the failure cases.
- [ ] Running a second instance while one is running exits 75 straight away, creates no run dir, and leaves the first run's `meta.json` unchanged.
