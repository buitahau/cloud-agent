# 11 — Demo and failure drills (Milestone B)

**Estimate:** S (plus a passive 24–48 h soak) · **Depends on:** 08, 09, 10

## Goal
Run the full success-criteria demo from the README §3 on the real setup, record the evidence, and decide what comes after the MVP.

## Scope
- In: the 7 demo scenarios, a 5-run repeatability check, a multi-day auth soak, a findings write-up.
- Out: fixing larger issues found here. Those become new tasks in the next plan.

## Steps
1. Run scenarios 1–6 from README §3 in order. Capture the CLI output, `meta.json`, and the exit code for each. Scenario 5 uses the [timeout drill from task 05](05-runner-script.md): edit `TIMEOUT_MIN=2` into `/etc/cloudtest/config.env`, run, then restore the file (no service restart needed).
2. Repeatability: 5 consecutive green runs. Record the median wall time and its split from `meta.json`: `fetch_ms`, `install_ms` (`pnpm install` + venv check + browser check), `tests_ms` (from `junit.xml`), and Claude overhead = `claude_ms` − `tests_ms`. Compare with the task 02 baseline.
3. Report accuracy (A5): across all runs, record the rate of `agent_line_ok: false`, the `skipped`/`blocked` counts of the green runs (they should be stable from run to run), (a measurement: the runner's line 1 is correct either way; above 1 in 10 is a finding for the prompt) and count `suite run <n> times` errors (any is a blocker).
4. Auth soak: leave the service idle for ≥ 24 h (ideally 48 h), then trigger a run with no manual login. This settles A2 for the chosen auth method (the 26 h check from task 03 is the early signal).
5. Usage: total the turns and usage across all runs (A7).
6. Disk: record `du -sh` of `/var/lib/cloudtest/runs`, `/var/lib/cloudtest/repo/.git`, `~cloudtest/.claude`, `~cloudtest/.cache/ms-playwright`, the pnpm store and `/var/lib/cloudtest/venv-e2e`, and the per-run growth.
7. Write `docs/mvp/findings/11-demo.md`: pass/fail per scenario, timings, usage, disk, the soak result, surprises, and the recommended next steps (e.g. artifact endpoint, node_modules cache, failure-only Claude mode, deploy step if A3 was false, run cleanup, dashboard).

## Acceptance criteria
- [ ] All 7 success criteria from README §3 are marked pass in `findings/11-demo.md`, each with its evidence (output snippet or file path).
- [ ] 0 `suite run <n> times` across all runs; the `agent_line_ok` rate is recorded.
- [ ] The soak run succeeds without re-login, or the failure is documented together with a chosen mitigation (API key or a scheduled re-login check).
- [ ] `findings/11-demo.md` ends with a go/no-go for building the full design, plus an ordered list of the next 3–5 tasks.
