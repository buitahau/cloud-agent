# 02 — Manual E2E run from the VPS against dev

**Estimate:** M · **Depends on:** 01

## Goal
Confirm A1 fully: the target repo's Python Playwright + pytest suite, run **by hand without Claude**, works from the VPS against the dev environment. This gives a baseline (time, counts, resource use) that all later runs are compared with, and fixes the list of e2e folders the MVP runs.

## Scope
- In: the git token and askpass helper, a manual clone of `dev-v2`, `pnpm install --frozen-lockfile`, browser install, a run of the chosen folders and a one-off run of every folder, measurements.
- Out: any automation, Claude, the API. A3 is already answered in task 00.

## Steps
1. Create a fine-grained GitHub PAT: read-only Contents on the target repo only. Store it at `/etc/cloudtest/github-token` (`root:cloudtest`, `0640`).
2. Write `vps/askpass.sh` in this repo (deployed for real in task 05; copy it to `/opt/cloudtest/vps/` now): if `$1` starts with `Username`, print `x-access-token`; otherwise print the contents of `/etc/cloudtest/github-token`. Mode `0755`. Always call it by absolute path.
3. As `cloudtest`, clone with `GIT_ASKPASS=/opt/cloudtest/vps/askpass.sh GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone -b dev-v2 <repo> /var/lib/cloudtest/repo` (`main` is empty; `dev-v2` is the active branch). This is a **normal clone**, used only as the object store for per-run worktrees (task 05). Runs never execute inside it; the spike runs in tasks 02–04 are the only exceptions (task 04 restores it to a clean state at the end).
4. Write `/etc/cloudtest/project.env` (`KEY=value` lines, quoted where needed): `E2E_BASE_URL=https://sweetmemories-dev.<account>.workers.dev` (the dev URL from the target repo's `docs/infra/dev-environment.md`) and any other variable task 00b found. The chosen folders need no credentials (dev holds synthetic data only); never add Neon, Cloudflare or `gh` credentials here.
5. In the clone: `pnpm install --frozen-lockfile`, then `/var/lib/cloudtest/venv-e2e/bin/playwright install chromium` (browsers are cached in `~cloudtest/.cache/ms-playwright`). Time both.
6. Run the chosen folders with the same settings the runner will use (`CI=1`, the shared venv, JUnit XML, `-rs`):
   `set -a; . /etc/cloudtest/project.env; set +a; CI=1 /usr/bin/time -v /var/lib/cloudtest/venv-e2e/bin/pytest e2e/project-skeleton e2e/homepage -rs -p no:cacheprovider --junitxml=/tmp/baseline-junit.xml 2>&1 | tee /tmp/baseline.log; echo "exit ${PIPESTATUS[0]}"`
   (`scripts/e2e-ci.sh` does not exist yet; task 04 wraps exactly this command.)
7. Run every folder once, per folder, the same way (`--junitxml=/tmp/all-<folder>.xml`), and record passed/failed/skipped/BLOCKED per folder with the skip reasons from `-rs`. This is evidence for the folder list in task 04 step 1, not a gate: folders that need `gh`, Neon or Cloudflare will skip as BLOCKED here, by design.
8. Screenshots: check what a failing browser test leaves on disk. The suite has no automatic failure screenshot today (the per-folder `shot` fixture writes `e2e/<folder>/screenshots/<name>.png` only where a test calls it). Confirm that by breaking one assertion in a `page` test in the clone, running that folder, and restoring with `git checkout -- .`. If no screenshot of the failing state exists, note it; task 04 commits a hook.
9. If anything fails, sort it into: network (DNS, connect refused/timeout, 403), environment (missing deps, fonts), dev serving an older commit than the clone's tests expect (A3), or a real test failure. Compare with the same run on the laptop (the task 00b baseline, if done; same SHA).

## Acceptance criteria
- [ ] The chosen folders run to completion on the VPS. The counts match a laptop run on the same SHA (both with `CI=1` and the same `E2E_BASE_URL`), or every difference is explained.
- [ ] No failures are caused by network reachability, and at least one test executed (not only skips).
- [ ] `/tmp/baseline-junit.xml` exists and its per-`<testcase>` counts (passed, failed + errors, skipped, task 04 step 4) and `<testsuite>` `time` match pytest's summary line.
- [ ] `docs/mvp/findings/02-dev-reachability.md` records: the SHA, wall time, the JUnit counts and BLOCKED skip reasons, pytest's exit status, peak RSS from `time -v`, `pnpm install` and `playwright install` times, the per-folder table from step 7 with the proposed folder list, the screenshot result, and any env vars needed.
- [ ] `.git/config` in the clone contains no token: `grep -Ec 'ghp_|github_pat_' /var/lib/cloudtest/repo/.git/config` prints 0, and `git config --get-all credential.helper` prints nothing.

## Exit / stop condition
If dev cannot be reached from the VPS by the browser (even though task 00's `curl` passed), **stop**. The design has to change before task 03. If the chosen folders execute no test against dev (everything skips), **stop** and change the folder list before task 03.
