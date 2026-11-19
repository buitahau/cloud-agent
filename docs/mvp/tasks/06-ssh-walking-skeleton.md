# 06 — SSH walking skeleton (Milestone A)

**Estimate:** S · **Depends on:** 05

## Goal
Prove the whole idea from the laptop with the thinnest possible trigger: push, SSH, report. If this works, the concept is feasible. Everything after it is about robustness (surviving disconnects) and ergonomics.

## Scope
- In: `laptop/cloudtest-ssh` (about 20 lines of bash). SSH access (task 01) and the deployed `vps/` (task 05) already exist.
- Out: async behaviour and disconnect survival. This script is kept only as a debug fallback afterwards. After task 08, use `cloudtest-ssh` only while the service has no work, and do not restart the service during an SSH run (the server's startup recovery assumes it owns every run dir, task 07 step 3).

## Steps
1. Script: `sha=$(git rev-parse HEAD)`, `git push -f origin HEAD:refs/heads/agent/test` (the full ref, so the push works from a detached `HEAD` when the branch does not exist yet), `id=$(date -u +%Y%m%d-%H%M%S)-${sha:0:7}` (UTC, as in task 07), then `ssh cloudtest@cloudtest-vps "/opt/cloudtest/vps/run-once.sh /var/lib/cloudtest/runs/$id $sha"; rc=$?`, then `echo "sha $sha"; ssh … cat /var/lib/cloudtest/runs/$id/report.md`, print the run dir, then `exit $rc`.
2. Run the green and red scenarios from the laptop.
3. Kill the `ssh` client mid-run. With no TTY (plain `ssh host cmd`, not `-t`) and a runner that writes nothing to stdout (task 05 step 3), the run should carry on to the end on the VPS; read the report afterwards with `ssh … cat <run_dir>/report.md`.

## Acceptance criteria
- [ ] From the laptop in the target repo, `cloudtest-ssh` on a green commit prints `RESULT: PASS …` and exits 0. On a red commit it prints the failure list and exits 1.
- [ ] The SHA in `meta.json` equals the laptop's `git rev-parse HEAD`.
- [ ] After the step 3 kill, the run ends `done` with the same result as an undisturbed run of the same SHA (`error / runner crashed` fails this AC), its worktree is gone, and the next `cloudtest-ssh` does not exit 75.
- [ ] **Milestone A** is recorded in `docs/mvp/findings/06-milestone-a.md` with the wall times of both runs.
