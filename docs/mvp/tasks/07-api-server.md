# 07 — API server with file-backed queue

**Estimate:** M · **Depends on:** 04 (the runner contract); the last AC needs 05

## Goal
Use an async job contract so that a run does not depend on the laptop staying connected: `POST` returns a `run_id` straight away, a serial worker runs `run-once.sh`, and `GET` returns status and report.

## Scope
- In: `vps/server.mjs` (Node 24, no dependencies), bearer auth, `POST /api/runs`, `GET /api/runs/:id`, `GET /healthz`, an in-process serial queue, startup recovery, a fake runner for tests. The fake runner and `smoke.sh` run on the laptop and need `jq` there (the fake runner does the contract's `jq` merges).
- Out: dashboard, artifact download, cancel, listing runs, multi-project.

## API contract
- Auth: `Authorization: Bearer <token>`, compared with the contents of `API_TOKEN_FILE` (README §2.1) using `crypto.timingSafeEqual`. A bad token gets `401 {error}`.
- `POST /api/runs` body `{project, sha}`:
  - `project` ≠ `PROJECT` from the config gives `404`. `sha` not matching `^[0-9a-f]{40}$` gives `422`.
  - If a run for the same SHA is `queued` or `running`, return `200 {run_id, sha, status}` for that run (same shape as `202`; idempotent retry).
  - Otherwise create `$RUNS_DIR/<id>/meta.json` `{id, project, sha, status: "queued", created_at}`, push it onto the queue, and return `202 {run_id, sha, status: "queued"}`.
- `GET /api/runs/:id`: `:id` must match `^\d{8}-\d{6}-[0-9a-f]{7}$`, else `404`. Returns `200 {id, project, sha, status, result, reason, created_at, started_at, finished_at, run_dir, report_md}` (`report_md` once the run is finished), or `404`.
- `GET /healthz` (no auth) returns `200 {ok: true}` and nothing else.
- Run id: `YYYYMMDD-HHMMSS-<sha7>`, time in UTC (`date -u` on the SSH path, task 06). It sorts by time and is easy to read in `ls`.

## Steps
1. Write the HTTP handler with `node:http`, a JSON body limit of 4 KB, and a log line per request.
2. Queue: an array plus a `busy` flag. The worker loop spawns `$RUNNER <run_dir> <sha>` and follows the [runner contract](04-prompt-and-report-contract.md#runner-contract): the runner is the only writer of `meta.json` while it runs. After the child exits, the server re-reads `meta.json`; if the status is still `queued`/`running` (e.g. exit 75, or a crash before the trap), it merges `error / runner exited <code>` (task 04 row O2). A runner-written final status is never overwritten.
3. Startup recovery: scan `$RUNS_DIR/*/meta.json`. For each `running` run: `rm -rf <run_dir>/wt`, `git -C /var/lib/cloudtest/repo worktree prune` (best effort; ignore its failure, the laptop smoke test has no clone), then merge `error / worker restarted` (row O3). Then `queued` runs go back into the queue in id order. The server kills no processes: under systemd, `KillMode=control-group` has already killed the runner, claude and Chromium when the old server died (task 08).
4. `PROJECT`, `BIND`, `PORT`, `RUNNER`, `RUNS_DIR` and `API_TOKEN_FILE` come from the environment, read once at start (README §2.1; the unit loads `config.env`). Refuse to start if `BIND` is `0.0.0.0` or empty.
5. Write `vps/fake-run.sh`: it follows the runner contract (merges `running`, creates `<run_dir>/wt/` at start, sleeps `FAKE_SLEEP` s (default 2), writes a final status and `report.md`, removes `wt/` at a normal end, exits with the matching code; `exit9` leaves `wt/` behind). At each start it reads `FAKE_RESULT=pass|fail|error|timeout|exit9` and `FAKE_SLEEP` from `$RUNS_DIR/fake.env` if that file exists, so a test changes the outcome by rewriting the file, with no server restart.
6. Write `vps/smoke.sh`. It runs **on the laptop**: it makes a temp dir, writes a token file, starts `PROJECT=demo BIND=127.0.0.1 PORT=18787 RUNNER=vps/fake-run.sh RUNS_DIR=$tmp/runs API_TOKEN_FILE=$tmp/token node vps/server.mjs` in the background, runs the curl checks, and stops the server. Task 09 tests use the same server setup (`CLOUDTEST_URL=http://127.0.0.1:18787`, `CLOUDTEST_TOKEN`).

## Acceptance criteria
- [ ] `vps/smoke.sh` with the fake runner passes: 401 without a token, 404 for a wrong project, 422 for a bad SHA, 404 for `curl --path-as-is /api/runs/../etc` and for `/api/runs/%2e%2e%2fetc`, 202 then `queued → running → done`, a duplicate POST returns `200` with the same `run_id`, and two different SHAs run one after the other (never overlapping, which shows in the `started_at`/`finished_at` times).
- [ ] With `FAKE_SLEEP=30` in `fake.env`: `kill -9` the server and `pkill -f fake-run.sh` during a run (standing in for systemd's cgroup kill), then restart: that run becomes `error / worker restarted`, its `wt/` is gone, and a queued run behind it then completes. (The real process check is task 08 AC 3.)
- [ ] `FAKE_RESULT=exit9` (exits 9 without a final write) gives `error / runner exited 9`.
- [ ] With the real runner (task 05), one green run through the API completes and `GET` returns the report.
