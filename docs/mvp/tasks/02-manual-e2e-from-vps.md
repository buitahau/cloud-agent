# 02 — Manual E2E run from the VPS against dev

**Estimate:** M · **Depends on:** 01

## Goal
Confirm A1 fully: the target repo's Playwright suite, run **by hand without Claude**, works from the VPS against the dev environment. This gives a baseline (time, pass count, resource use) that all later runs are compared with.

## Scope
- In: the git token and askpass helper, a manual clone, `npm ci`, browser install, a full suite run, measurements.
- Out: any automation, Claude, the API. A3 is already answered in task 00.

## Steps
1. Create a fine-grained GitHub PAT: read-only Contents on the target repo only. Store it at `/etc/cloudtest/github-token` (`root:cloudtest`, `0640`).
2. Write `vps/askpass.sh` in this repo (deployed for real in task 05; copy it to `/opt/cloudtest/vps/` now): if `$1` starts with `Username`, print `x-access-token`; otherwise print the contents of `/etc/cloudtest/github-token`. Mode `0755`. Always call it by absolute path.
3. As `cloudtest`, clone with `GIT_ASKPASS=/opt/cloudtest/vps/askpass.sh GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone <repo> /var/lib/cloudtest/repo`. This is a **normal clone**, used only as the object store for per-run worktrees (task 05). Runs never execute inside it; the spike runs in tasks 02–04 are the only exceptions (task 04 restores it to a clean state at the end).
4. Write the dev env vars the suite needs (base URL, test-account credentials) to `/etc/cloudtest/project.env` (`KEY=value` lines, quoted where needed). Use **test-only accounts**.
5. `npm ci && npx playwright install chromium` (browsers are cached in `~cloudtest/.cache/ms-playwright`). Time `npm ci`.
6. Run with the same settings the runner will use (`CI=1`, list+json reporters):
   `set -a; . /etc/cloudtest/project.env; set +a; CI=1 PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/baseline-pw.json /usr/bin/time -v npx playwright test --reporter=list,json 2>&1 | tee /tmp/baseline.log`
7. Check that the Playwright config takes screenshots on failure (`screenshot: 'only-on-failure'` or `'on'`) and that `outputDir` is the default `test-results/`. If not, note the change needed; task 04 commits it to the target repo.
8. If anything fails, sort it into: network (DNS, connect refused/timeout, 403 from an IP allow-list), environment (missing deps, fonts), or a real test failure. Compare with the same run on the laptop.

## Acceptance criteria
- [ ] The suite runs to completion on the VPS. The pass/fail counts match a laptop run on the same SHA (both with `CI=1`), or every difference is explained.
- [ ] No failures are caused by network reachability.
- [ ] `/tmp/baseline-pw.json` exists and its `stats` (`expected`, `unexpected`, `flaky`, `skipped`, `duration`) match the list output.
- [ ] `docs/mvp/findings/02-dev-reachability.md` records: wall time, the `pw.json` stats, peak RSS from `time -v`, `npm ci` time, the screenshot config result, and any env vars needed.
- [ ] `.git/config` in the clone contains no token: `grep -Ec 'ghp_|github_pat_' /var/lib/cloudtest/repo/.git/config` prints 0, and `git config --get-all credential.helper` prints nothing.

## Exit / stop condition
If dev cannot be reached from the VPS by the browser (even though task 00's `curl` passed), **stop**. The design has to change before task 03.
