# 03 — Claude headless auth and permissions spike

**Estimate:** L · **Depends on:** 01, 02

## Goal
Remove risk A2: `claude -p` must run fully non-interactively as `cloudtest` (no TTY, no prompts, subscription auth) in the repo from task 02, run the suite through exactly one allowed command, and produce a transcript plus a machine-readable result. Settle the exact command line and auth method that the runner (task 05) will use.

## Scope
- In: the CLI flags, the tool and permission set, output format, auth method and failure signatures, a non-TTY context, how repo settings interact, usage per run, starting the auth soak.
- Out: prompt polish (task 04), git, install and worktree handling (task 05).

## Steps
1. For the spike only, add an uncommitted `"e2e:ci": "playwright test --reporter=list,json"` script to the clone's `package.json` (task 04 commits it to the target repo). `npm ci` was already done in task 02. For the Bash-timeout check (AC 2), temporarily prefix the script with `sleep 660 && ` unless the suite itself runs over 600 s, so one run passes both Bash tool limits (120 s default, 600 s maximum).
2. In `/var/lib/cloudtest/repo`, as `cloudtest`, start a candidate command with **no TTY**:
   ```
   setsid --wait env -i HOME=/home/cloudtest PATH=/usr/local/bin:/usr/bin:/bin CI=1 \
     BASH_DEFAULT_TIMEOUT_MS=1200000 BASH_MAX_TIMEOUT_MS=1200000 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
     PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/pw.json \
     claude -p "Read CLAUDE.md, then run the E2E suite with: npm run e2e:ci, in the foreground (not in the background). Do not modify files. Summarise pass/fail." \
     --output-format stream-json --verbose \
     --model <pinned model> --max-turns 30 \
     --tools "Read,Grep,Glob,Bash" \
     --allowedTools "Bash(npm run e2e:ci)" \
     --disallowedTools "Read(//etc/cloudtest/**)" "Read(~/.claude/**)" \
     --permission-mode dontAsk --strict-mcp-config --no-session-persistence \
     < /dev/null > /tmp/transcript.jsonl 2> /tmp/claude.err
   jq -c 'select(.type=="result")' /tmp/transcript.jsonl > /tmp/claude.json
   ```
   `setsid --wait` detaches from the terminal but waits for claude, so the `jq` line runs on a finished transcript and `$?` is claude's exit code (plain `setsid` in an interactive shell forks and returns at once). `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` lift Claude Code's own Bash tool limit (default 120 s, max 600 s); in the runner they equal `TIMEOUT_MIN` in ms, so the outer `timeout` is the only real cap. **For this spike run only**, set both to 660 s + the task 02 suite time + a margin (the 1 200 000 shown fits a suite under about 8 min), so the `sleep 660` stand-in cannot push the single call over the limit. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` should remove the Bash tool's `run_in_background` option; verify it in the `init` event's tool schema or by asking the agent to run the suite in the background. The prompt line stays as a second guard. Read-only tools need no allow rule inside the working directory; outside it they would prompt, and `dontAsk` denies. A leading `//` in a rule is a filesystem-absolute path (a single `/` is relative to the project root). Every flag is a candidate: confirm each exists in the pinned version (`claude --help`). In particular confirm `--max-turns` is accepted and that `subtype: error_max_turns` still exists; if not, use `--max-budget-usd` as the cap and record its signature. If `--permission-mode dontAsk` is not available, use the equivalent that denies instead of prompting (e.g. `--permission-prompts none`).
3. Also run it through `systemd-run --uid=cloudtest --pipe --wait -p WorkingDirectory=/var/lib/cloudtest/repo -p Environment=HOME=/home/cloudtest -p Environment=PATH=/usr/local/bin:/usr/bin:/bin` followed by the same `env -i … claude …` command without `setsid --wait`, to copy the service context. Note which env vars are required (`HOME`, `PATH`).
4. Count denied tool calls in a full green run (`tool_result` events with a permission-denied error in `transcript.jsonl`). Target 0; if the agent tries variants (`… | tail`, `cd … &&`, extra args), tighten the prompt until it is 0 and record what it tried. Confirm `Bash(npm run e2e:ci)` matches only the exact command (try asking for `npm run e2e:ci -- some.spec.ts` and check it is denied).
5. Check that a non-allowed action is **denied, not prompted**: ask it to `rm package.json`, edit a file, and use `Read`, `Grep` and `Glob` on `/etc/cloudtest/github-token` and `~/.claude/.credentials.json`. The process must neither hang nor succeed. Check that reading `CLAUDE.md` in the repo still works.
6. Look at the transcript and the `result` event: record the fields that matter (`result`, `subtype`, `is_error`, `num_turns`, usage/`total_cost_usd`, `duration_ms`) and how to find `Bash` `tool_use` calls with their `command` and the matching `tool_result`. Record how a permission-denied call and a non-zero exit of the command each show up in that `tool_result` (e.g. `is_error`, exit code text). Task 04 counts executed suite runs and checks the suite's exit status this way.
7. **Auth method:** compare the `.credentials.json` login from task 01 with `claude setup-token` (long-lived token, passed as `CLAUDE_CODE_OAUTH_TOKEN` through `env -i`, stored in `/etc/cloudtest/claude-token`, `root:cloudtest 0640`). Pick one and record why. If `setup-token` is chosen, log `cloudtest` out (remove `~cloudtest/.claude/.credentials.json`) so the token is the only auth source, and record that. Then record the auth-failure signature (exit code, `is_error`, `result` text, stderr) for the chosen method: move `.credentials.json` aside, or pass an invalid token value. For the file method, also record a real expiry signature (a 401 from the API) if one can be produced. Write down a grep/jq pattern that detects it; anything it misses lands in task 04 row 6 with its message, which is acceptable. Restore. Keep the transcripts of the auth-failure run and of the step 9 max-turns run (check them for secrets): they are the fixtures for task 04 rows 4–5 in task 05.
8. If a usage-limit error happens to be observed, record its text. It needs no row of its own: task 04's `claude failed: <message>` row carries the message.
9. Max turns: run with `--max-turns 2` and record the signature.
10. Repo settings (R1): put a temporary `.claude/settings.json` with `{"permissions": {"allow": ["Bash"]}}` in the repo and ask the agent to run `touch x`. If it runs, add `--setting-sources user` and check again. Whatever is chosen, check that the agent still follows `CLAUDE.md` (e.g. it uses the command written only there); the prompt's explicit "Read CLAUDE.md" is the fallback.
11. **Start the auth soak:** `systemd-run --uid=cloudtest --on-active=26h -p Environment=HOME=/home/cloudtest -p StandardOutput=file:/var/lib/cloudtest/soak-26h.json claude -p "say ok" --output-format json` with the chosen auth (add `CLAUDE_CODE_OAUTH_TOKEN` if chosen). The timer is transient: **do not reboot the VPS before it fires.** The soak matters most for the `.credentials.json` refresh path; with `setup-token` it is a sanity check. Task 08 reads the result.

## Acceptance criteria
- [ ] One command line (written in the findings) runs the full suite headless, ends by itself, exits 0, and leaves a `transcript.jsonl` whose last event is `type=result`. It works in both the `setsid --wait … </dev/null` and the `systemd-run` contexts.
- [ ] With a suite (or the `sleep 660` stand-in) longer than 600 s, the single `npm run e2e:ci` Bash call returns its real exit status: no tool timeout, no backgrounding, no second call.
- [ ] A full green run has 0 denied tool calls and exactly one `npm run e2e:ci` call.
- [ ] Disallowed writes are refused without hanging, and `git status` stays clean. `Read`, `Grep` and `Glob` on `/etc/cloudtest/github-token` and `~/.claude/.credentials.json` are all refused; reading `CLAUDE.md` in the repo works.
- [ ] Auth failure, max-turns and success each have a documented, distinct signature (exit code + `result`-event field or stderr pattern).
- [ ] `docs/mvp/findings/03-claude-headless.md` records the final flags, chosen auth method, required env, signatures (including how a denied call and a non-zero command exit appear in a `tool_result`), turns/duration/usage for a full run, the repo-settings result (whether a repo `Bash` allow rule widened permissions, and the flag chosen), and the soak timer's unit name.

## Exit / stop condition
If neither auth method can run unattended, decide between an API key (`ANTHROPIC_API_KEY` from Console, billed per token) and stopping. Record the decision before task 04.
