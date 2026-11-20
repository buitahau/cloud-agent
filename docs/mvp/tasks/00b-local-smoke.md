# 00b — Local smoke test (laptop stands in for the VPS)

**Estimate:** M (≤ half a day) · **Depends on:** none · **Optional:** no task depends on it, and it replaces no step of tasks 00–02. Do it while the VPS is not ready yet. Its step 1 is task 00 step 1.

## Goal
Check the basics on the laptop before you pay for or set up a VPS. The target repo's Playwright suite must run headless against dev with the runner's settings, and `claude -p` must run headless, with no prompts, and return a result you can parse. This catches repo, suite and Claude problems early. It does not cover the VPS questions: reachability from the VPS IP, the `cloudtest` user, systemd, the auth method, and sizing stay in tasks 00–03.

## Scope
- In: the A3 answer, `curl` from the laptop, a throwaway clone, a full suite run with the runner's settings, a red run, the headless Claude hello-world, a findings note.
- Out: the `cloudtest` user, `/etc/cloudtest`, systemd units, Tailscale, the API, the runner script (tasks 01, 05, 07, 08). Nothing is installed outside `~/cloudtest-local` except the repo's own Playwright browser cache.

Commands assume a Linux laptop. On macOS, use `/usr/bin/time -l` and drop `setsid --wait`. Claude credentials are also in the Keychain there, not in `~/.claude`, so step 9 tells you less about the VPS.

## What local can and cannot prove

| Question | Local result |
|---|---|
| A3 (do tests target what dev serves?) | Fully answered (task 00 step 1). |
| A1 (reach dev) | **Only from your own IP.** It says nothing about the VPS IP, so task 00 step 2 is still needed before task 01. |
| Laptop baseline | Yes. This is the laptop run that task 02 AC 1 compares with (same SHA, `CI=1`). |
| A2 (headless `claude -p`) | Partly. It checks no TTY, no prompts and a clean env, but with your own login. It does not check the `cloudtest` user, systemd or the auth method (task 01 step 7, task 03). |
| A4, A5 (prompt, report) | Rehearsal only (see "After this task"). The ACs of tasks 03–04 are ticked on the VPS. |
| A6 (resources) | No. The laptop is not the VPS size. Peak RSS is only a reference point. |

## Steps
1. Answer **A3** in writing ([task 00](00-preflight.md) step 1) in `docs/mvp/findings/00-preflight.md`. Task 00 AC 1 is then done, and only task 00 step 2 is left for the VPS.
2. Check reachability from the laptop: `curl -sS -o /dev/null -w '%{http_code}\n' "$BASE_URL"`, and the same for every login/API host the suite uses. Record the codes. If a host needs a VPN, note that the VPS will need the same.
3. Make a scratch workspace outside this repo: `mkdir -p ~/cloudtest-local/{runs,secrets}`. Put the dev env vars the suite needs (base URL, **test-only** credentials) in `~/cloudtest-local/secrets/project.env` as `KEY=value` lines, quoted where needed (the same format as `/etc/cloudtest/project.env`, task 02). Then run `chmod 600` on that file.
4. Make a fresh clone of the target repo (not your working copy): `git clone <repo> ~/cloudtest-local/repo`. Use your normal git auth. The PAT and askpass helper are VPS work (task 02). Record `git rev-parse HEAD`, `node -v` (flag it if it is not v22, PREREQUISITES §3) and the repo's Playwright version (task 01 step 4 needs it).
5. In the clone: `npm ci && npx playwright install chromium`. Time `npm ci`.
6. In the clone, run the suite as the runner will, with a clean environment so that nothing leaks in from your shell. `/usr/bin/time` comes from the `time` package, which a laptop may not have:
   `env -i HOME="$HOME" PATH="$PATH" CI=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$HOME/cloudtest-local/runs/baseline-pw.json" bash -c 'set -a; . ~/cloudtest-local/secrets/project.env; set +a; exec /usr/bin/time -v npx playwright test --reporter=list,json' 2>&1 | tee ~/cloudtest-local/runs/baseline.log`
   `PATH` is your own, not the runner's fixed `PATH`. That is fine here, because task 02 checks the VPS paths.
7. Check the screenshot config as in task 02 step 7: `screenshot: 'only-on-failure'` or `'on'`, and the default `outputDir`.
8. Force one failure: edit an assertion in the **scratch clone only**. Run the step 6 command again with `red` in place of `baseline` in both file names. The red run must leave a screenshot under `test-results/` and show `unexpected` ≥ 1 in `red-pw.json`. Then run `git checkout -- .`.
9. Headless Claude check with no controlling terminal, nothing on stdin and a clean env. Use the Claude Code version you will pin (README §2), or record both versions if yours differs:
   `setsid --wait env -i HOME="$HOME" PATH="$PATH" claude -p "say ok" --output-format json </dev/null >~/cloudtest-local/runs/hello.json; echo "exit $?"`, then `jq '.is_error, .result' ~/cloudtest-local/runs/hello.json`.
   `env -i` drops any `ANTHROPIC_API_KEY` set in your shell. Check that it cannot come back from settings: `jq '.env.ANTHROPIC_API_KEY, .apiKeyHelper' ~/.claude/settings.json` must print `null` twice. Otherwise you are testing API billing, not the subscription. If you use `CLAUDE_CONFIG_DIR`, add it to `env -i`.
10. (Optional) Run the same call through your user's service manager: `systemd-run --user --pipe --wait -E PATH="$PATH" claude -p "say ok" --output-format json </dev/null`. This shows that no login-shell state is needed. It is still your user and your login, not `cloudtest` under the system manager (task 01 step 7).

## Acceptance criteria
- [ ] `docs/mvp/findings/00-preflight.md` records the A3 answer and what it means for the demo (task 00 AC 1).
- [ ] Every dev host the suite uses returns 2xx/3xx from the laptop, or the blocker is recorded with an owner.
- [ ] The suite runs to completion locally with `CI=1`, and the `stats` in `baseline-pw.json` (`expected`, `unexpected`, `flaky`, `skipped`, `duration`) match the list output. Every failure is explained (environment or a real test failure).
- [ ] The deliberate failure gives a red run with a screenshot on disk, and afterwards the clone has no changes to tracked files (`git status --porcelain --untracked-files=no` prints nothing).
- [ ] The step 9 hello-world exits 0 with `is_error == false`, does not prompt, and the settings check prints `null` twice.
- [ ] `docs/mvp/findings/00b-local.md` records: the SHA, `node -v`, the Playwright version, the HTTP codes, wall time, `npm ci` time, peak RSS, the `pw.json` stats, the screenshot config result, the Claude Code version used (and the pinned one if different), and every env var the suite needs.

## Exit / stop condition
If the suite cannot run to completion against dev from the laptop, or has failures nobody can explain, **stop** and fix that first. The same applies if `claude -p` cannot run without prompting. A VPS will make neither easier. A laptop that is blocked only by a VPN is not a stop: record it, because the VPS will hit the same thing (task 00 step 2).

## After this task
- **Can be done on the laptop now:** the spec parts of task 04 (steps 2–6 and the runner contract). Task 05 `classify.mjs`, with hand-made fixtures; rows 4, 5, 12 and 13 still need the real transcripts from tasks 03–04. Tasks 07 and 09 against the fake runner, which run on the laptop by design (`BIND=127.0.0.1`, task 07 step 6).
- **Rehearsal only:** task 03 steps 2, 4–6, 9 and 10, and task 04 step 7, can be tried in the scratch clone with `HOME="$HOME"`. Keep the `Read(~/.claude/**)` deny rule, because on the laptop it guards your real credentials. A rehearsal shows early whether the flags and prompt work. The ACs of tasks 03–04 are still ticked on the VPS, because they are about the `cloudtest` user, `/etc/cloudtest`, the service context and the auth method.
- **Not on the laptop:** `run-once.sh` (task 05 ACs 2–8). It uses `/etc/cloudtest` and `/var/lib/cloudtest` by design (README §2.1), and the plan has no path overrides for it.
- **Before task 01:** do task 00 step 2 from the VPS. A local pass does not prove A1 for the VPS IP.
