# 00b — Local smoke test (laptop stands in for the VPS)

**Estimate:** M (≤ half a day) · **Depends on:** none (A3 from task 00 is still answered in writing) · **Replaces for now:** the VPS parts of 00, 01 and 02

## Goal
Prove the basic feature locally before paying for or provisioning a VPS: the target repo's Playwright suite runs headless against dev, and `claude -p` runs headless and returns a parsable result. Everything learned here is re-checked on the VPS later, so the VPS work shrinks to "repeat on another machine".

## Scope
- In: A3 answer, `curl` from the laptop, a throwaway clone, a full suite run with the runner's settings, the headless Claude hello-world, a findings note.
- Out: the `cloudtest` user, `/etc/cloudtest`, systemd, Tailscale, the API, the runner script (tasks 01, 05, 07, 08). Nothing here is installed outside `~/cloudtest-local`.

## What local can and cannot prove

| Question | Local result |
|---|---|
| A3 (do tests target what dev serves?) | Fully answered, same as task 00. |
| A1 (reach dev) | **Only from your own IP.** It says nothing about the VPS IP; task 00 step 2 is still required before task 01. |
| A2 (headless `claude -p`) | Partly: no TTY and no prompts can be checked, but your interactive login is reused. Not a test of a service user or systemd. |
| A4, A5 (prompt, report) | Fully testable (tasks 03–04 can start locally). |
| A6 (resources) | No: the laptop is not the VPS size. |

## Steps
1. Answer **A3** in writing, as in [task 00](00-preflight.md) step 1.
2. Reachability from the laptop: `curl -sS -o /dev/null -w '%{http_code}\n' "$BASE_URL"` and the same for every login/API host the suite uses. Record the codes. If a host needs a VPN, note that the VPS will need the same.
3. Make a scratch workspace outside this repo: `mkdir -p ~/cloudtest-local/{runs,secrets}`. Put the dev env vars the suite needs (base URL, **test-only** credentials) in `~/cloudtest-local/secrets/project.env` as `KEY=value` lines, mode `0600`.
4. Clone the target repo fresh (not your working copy): `git clone <repo> ~/cloudtest-local/repo`. Use your normal git auth; the PAT and askpass helper are VPS work (task 02).
5. In the clone: `npm ci && npx playwright install chromium`. Time `npm ci`.
6. Run the suite as the runner will, with a clean environment so nothing leaks in from your shell:
   `env -i HOME="$HOME" PATH="$PATH" CI=1 PLAYWRIGHT_JSON_OUTPUT_NAME=$HOME/cloudtest-local/runs/baseline-pw.json bash -c 'set -a; . ~/cloudtest-local/secrets/project.env; set +a; /usr/bin/time -v npx playwright test --reporter=list,json' 2>&1 | tee ~/cloudtest-local/runs/baseline.log`
7. Check the screenshot config as in task 02 step 7 (`screenshot: 'only-on-failure'` or `'on'`, default `outputDir`).
8. Force one failure (edit an assertion in the **scratch clone only**) and confirm the red run produces a screenshot under `test-results/` and `unexpected` ≥ 1 in the JSON. Then `git checkout .`.
9. Headless Claude check, with no TTY and nothing on stdin: `claude -p "say ok" --output-format json </dev/null`. Record the exit code, and check `is_error == false` in the JSON. Confirm `ANTHROPIC_API_KEY` is unset (`env | grep ANTHROPIC_API_KEY` prints nothing), otherwise you are testing API billing, not the subscription.
10. (Optional, closer to the service) Run step 9 through `systemd-run --user --pipe --wait claude -p "say ok" --output-format json </dev/null` to see it work without your shell environment.

## Acceptance criteria
- [ ] `docs/mvp/findings/00b-local.md` records the A3 answer and its consequence for the demo (as task 00 AC 1).
- [ ] Every dev host the suite uses returns 2xx/3xx from the laptop, or the blocker is recorded with an owner.
- [ ] The suite runs to completion locally with `CI=1`; the `baseline-pw.json` `stats` (`expected`, `unexpected`, `flaky`, `skipped`, `duration`) match the list output.
- [ ] The deliberate failure gives a red run with a screenshot on disk, and the clone is clean again afterwards (`git status --short` prints nothing).
- [ ] The headless hello-world exits 0 with `is_error == false` and does not prompt.
- [ ] The findings note also records: wall time, `npm ci` time, peak RSS, the screenshot config result, the Claude Code version, and every env var the suite needs.

## Exit / stop condition
If the suite cannot pass locally against dev, or the headless `claude -p` cannot run without prompting, **stop**. Fix that first: a VPS will not make either easier.

## After this task
Tasks 03 (Claude spike), 04 (prompt and report contract) and the fixture-based parts of 05 (`classify.mjs`) and 07/09 (tested with the fake runner) can be done on the laptop. Before task 01, still do task 00 step 2 from the VPS: a local pass does not prove A1 for the VPS IP.
