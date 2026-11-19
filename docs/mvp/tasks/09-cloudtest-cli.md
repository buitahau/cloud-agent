# 09 — `cloudtest` CLI

**Estimate:** M · **Depends on:** 07 (fake-runner server); the real-service ACs need 08

## Goal
A single laptop command that the dev agent can run as a background command. It pushes, starts a run, survives disconnects, prints a compact report, and signals the outcome through its exit code.

## Scope
- In: `laptop/cloudtest.mjs` (Node 22, no dependencies, symlinked onto `PATH` as `cloudtest`) with the commands `run <project>` and `wait <run_id>`.
- Out: a separate `status` command (`wait` covers it), artifact download (print the VPS run dir plus a ready-made `scp` hint), config wizard, multi-server support.

## Behaviour
- Config: `~/.config/cloudtest/config.json` `{url: "http://cloudtest-vps:8787", branch: "agent/test"}` (`branch` exists only here; the VPS fetches by SHA) and the token file from task 08. `CLOUDTEST_URL` and `CLOUDTEST_TOKEN` env vars override them.
- `run <project>`:
  1. Refuse if tracked files are dirty (`git status --porcelain --untracked-files=no` is not empty). The run must match a commit; untracked files are not part of it. Exit 4 with the hint "commit first".
  2. `sha = git rev-parse HEAD`, then `git push -f origin HEAD:refs/heads/<branch>` (the full ref works from a detached `HEAD` and for a branch that does not exist yet).
  3. `POST /api/runs`, print `run_id` and `sha`, and save the id to `.git/cloudtest-last-run`.
  4. Then do the same as `wait <run_id>`.
- `wait <run_id>`: poll `GET` every 5 s (fixed). Print a one-line status only when it changes. Retry network errors and 5xx without limit inside the deadline (`--deadline <minutes>`, default 60; one run takes at most 17 + `TIMEOUT_MIN` min, so 60 min covers one run plus a short queue). When the run ends, print `sha <sha>`, then `report_md` (or `reason` when `report_md` is null, task 04 O1–O3), then the absolute run dir (screenshot paths in the report are relative to `<run_dir>/artifacts/`) and an `scp` hint.
- Exit codes: `0` pass · `1` tests failed · `2` run error (reason printed) · `3` run timeout · `4` client/config error (401, 404, dirty tree, push failed) · `5` client deadline reached (the run continues on the server; the output says to use `cloudtest wait <id>`).
- Output is short and readable by the dev agent: no spinner and no ANSI colours when stdout is not a TTY.
- Known limit: a second push to `agent/test` before a queued run is fetched can make the first SHA unreachable on the VPS. That run then ends `error / fetch failed: <git error>`; run again.

## Steps
1. Implement the commands above. Use `child_process.execFileSync` for git.
2. Test on the laptop against the fake-runner server set up as in task 07 step 6 (outcomes switched through `fake.env`), then against the real service.
3. Disconnect test: during a real run, turn Wi-Fi off for 60 s. The CLI keeps retrying and then prints the report.

## Acceptance criteria
- [ ] With the fake runner: `cloudtest run` exits 0. A fake fail gives exit 1, a fake error exit 2, a fake timeout exit 3. `--deadline 0.1` with `FAKE_SLEEP=30` gives exit 5 and prints the `cloudtest wait <id>` hint. A wrong token gives exit 4 with a clear message. A modified tracked file gives exit 4 and nothing is pushed; an untracked file does not block the run.
- [ ] With the real service: a green commit exits 0 with the report printed and the printed `sha` equal to `git rev-parse HEAD`; a red commit exits 1.
- [ ] Ctrl-C during a run, then `cloudtest wait $(cat .git/cloudtest-last-run)`, prints the final report.
- [ ] The 60 s network drop does not end the CLI, and the final report is still printed.
