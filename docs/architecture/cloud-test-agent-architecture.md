# Cloud Test Agent — Architecture

Status: design draft · Audience: single user · Date: 2026-11-17

Synthesis of two source docs (kept in `../docs/`):
- *Remote Test Agent on VPS — Architecture Overview* (minimal, SSH-based)
- *Claude Agent Service — Architecture Overview* (full job-queue platform)

---

## 1. Goal

Offload E2E test runs from the laptop to a VPS so the laptop stays free for other work. Test runs need no manual verification or review, so they can run unattended in the background.

- A **dashboard** to create projects (GitHub repo, GitHub token, env vars, timeout).
- A **local tester agent** (Claude Code on the laptop) triggers a run.
- The **VPS** pulls the changes, spawns a Claude agent that runs the E2E tests defined in the repo (Playwright; for the MVP target repo, Python Playwright + pytest), and returns the result.

Constraints: one user (me), Playwright, no database needed by the tests, tests run against the **dev environment**, Claude Code is already logged in on the VPS.

## 2. Source docs compared

| | Remote Test Agent (doc 1) | Claude Agent Service (doc 2) |
|---|---|---|
| Shape | 2 shell scripts + SSH | HTTP API + Redis + SDK workers + proxy/tunnel |
| Trigger | `ssh vps run-tests <sha>` | `POST /jobs` → `202 {job_id}` |
| Result return | SSH stdout | Poll, SSE, webhook, WebSocket, MCP |
| Runs on | Exact SHA of scratch branch `agent/test` | Per-job git worktree |
| Concurrency | `flock` (one run) | Semaphore, scalable workers |
| Dashboard / projects | No (one hard-coded repo) | No (API keys only) |
| Weakness | SSH drop kills run; manual secrets | Far heavier than needed; built for arbitrary prompts/edits |

**Take from doc 1:** exact-SHA runs via scratch branch, one-at-a-time lock, timeout, read-only `claude -p` test agent, structured report, screenshots via artifacts.
**Take from doc 2:** async job contract (`job_id` + polling), result persisted before notify, job states (`queued → running → done/error/timeout`), per-job worktree, tool allow-list.
**Add (in neither):** project model with repo/token/env config and a dashboard.

## 3. Architecture

```
Laptop (Claude Code "dev agent")
  └─ cloudtest run <project>
        1. git push -f origin HEAD:agent/test        ──► GitHub
        2. POST /api/runs {project, sha}  ───────────►  VPS
        3. poll GET /api/runs/{id}  ◄───────────────   VPS

VPS (Docker Compose or systemd)
  ├─ App      : dashboard (server-rendered) + JSON API
  ├─ SQLite   : projects, runs (the runs table is the queue)
  └─ Worker   : one run at a time
        lock → git fetch (token) → worktree@sha
             → claude -p "<run prompt>"  (headless, read-only tools)
                  Claude reads repo docs, installs deps, runs the E2E suite,
                  diagnoses failures, writes report
             → save report + artifacts → status=done
```

Access: bind the dashboard to localhost/Tailscale, or a Cloudflare Tunnel (no open ports). One static API token for `/api`.

## 4. Components

| Component | Where | Role |
|---|---|---|
| Dev agent (Claude Code) | Laptop | Edits/commits code, triggers runs, acts on the report |
| `cloudtest` CLI | Laptop | Push scratch branch, start run, poll, print compact report, exit non-zero on fail |
| `CLAUDE.md` rule | Laptop repo | "Never run tests locally; commit, run `cloudtest run <project>` in the background, act on the report" |
| App (dashboard + API) | VPS | Project CRUD, run history, logs, screenshots |
| SQLite | VPS | `projects`, `runs` |
| Worker | VPS | Lock, fetch, worktree, run `claude -p`, store results |
| Test agent (`claude -p`) | VPS | Runs the repo-defined E2E suite, reports failures |
| Playwright + Chromium | VPS | Headless browser (MVP: Python Playwright in a venv, `playwright install --with-deps chromium`) |

## 5. Data model

`projects`: `id, name, repo_url, branch (default agent/test), github_token_enc, env_secrets_enc (JSON), timeout_min`
`runs`: `id, project_id, sha, status (queued|running|done|error|timeout), started_at, finished_at, exit_code, report_md, log_path, artifacts_dir`

The **test command is not stored in the dashboard**. It lives in the repo (`CLAUDE.md`, e.g. "E2E: `bash scripts/e2e-ci.sh`; base URL in `E2E_BASE_URL`"), so the agent discovers it from the source.

## 6. Run flow

1. Dev agent commits; `cloudtest` force-pushes `agent/test` (use `agent/test-<user>` if several machines push).
2. `POST /api/runs {project, sha}` returns `202 {run_id}` immediately.
3. Worker takes the lock, `git fetch` using the token via `GIT_ASKPASS` (never in the URL or on disk), creates a clean worktree at the SHA.
4. Worker runs `claude -p` in the worktree with the fixed prompt, env vars injected (e.g. `E2E_BASE_URL`), under `timeout`.
5. Claude runs the suite, reads failures/screenshots, writes the report.
6. Worker saves report + artifacts, sets `status=done` (or `error`/`timeout`).
7. `cloudtest` (polling every ~5 s with backoff) prints the report; dev agent fixes and repeats.

Claude Code runs `cloudtest` as a **background command**, so it keeps working meanwhile.

### Run prompt (template)
> Run the e2e tests as defined in this repository. Do not modify any files. Report pass/fail counts, then for each failure: test name, file:line, error, likely cause, and screenshot path.

### Report format
```
RESULT: FAIL  (42 passed, 3 failed)
1. e2e/checkout/test_checkout.py:57 "test_applies_coupon" — expected 10% off, got 0
   cause: coupon API returned 404 on dev
   screenshot: artifacts/checkout-applies-coupon.png
```

## 7. Claude on the VPS

- Auth: reuse the existing Claude Code login (personal use). **Ensure `ANTHROPIC_API_KEY` is unset** in the worker env — it takes precedence over the login.
- Detect auth failure and mark the run `error: claude login expired` instead of a vague failure.
- Headless cannot prompt: set `--allowedTools` explicitly — Read, Grep, Glob, and Bash limited to install/test commands. Read-only: no Edit/Write.
- Cap with `--max-turns` and wrap in `timeout`.
- Optional cheaper variant: worker runs the suite command directly and calls Claude only on failure to diagnose.

Trade-offs: every run uses subscription limits; slightly non-deterministic (pin the command in the repo's `CLAUDE.md`); added model latency.

> Terms note (from doc 2): Anthropic's terms do not allow routing *other people's* requests through a Free/Pro/Max login. Personal single-user use on my own server is the intended case. If anyone else ever triggers runs, switch to an API key. Re-check the current terms.

## 8. Security

- GitHub token: fine-grained PAT, read-only Contents on this one repo (or a deploy key). Used only by the worker for fetch; never passed to the test process.
- Encrypt token and env secrets at rest; master key from env, not in the DB; dashboard shows them write-only; mask in logs.
- Use **test-only credentials** for dev logins.
- One API token for `/api`; dashboard on Tailscale/localhost or behind Cloudflare Access.
- One fresh worktree per run. Docker-per-job is optional later (own repo, own VPS).

## 9. Project-specific risks

1. **Dev reachability (biggest):** the VPS must reach the dev URL. VPN/IP-allowlisted dev will fail on network, not tests. Check first.
2. **Dev state:** shared dev data can collide with manual use; use dedicated test accounts, concurrency = 1.
3. **What is under test:** if dev must run my branch, a deploy step is needed before tests. If tests only hit whatever dev currently serves, pull-and-test is enough. **Open question.**
4. **Sizing:** browsers want ~4 vCPU / 8 GB RAM; watch `htop` on first run.
5. **Dropped connections:** async job + polling survives laptop sleep (unlike plain SSH).

## 10. Deliberately cut

Redis, Caddy, webhooks, WebSocket, SSE streaming, `?wait=`, session resume, edit-capable agents and diffs, PreToolUse hook machinery, per-key budgets, multi-worker scaling, multi-user auth.

## 11. Build order

1. **Hand-run on VPS:** clone, install Playwright, run the suite against dev. Proves network + browser setup.
2. **Script version:** doc 1's two scripts (push + SSH). Already usable.
3. **API + worker:** SQLite, `POST /runs`, `GET /runs/{id}`, one project from a config file.
4. **`cloudtest` CLI:** push, start, poll, compact report, artifact download; add the `CLAUDE.md` rule.
5. **Dashboard:** project CRUD, encrypted token/env, run history, logs, screenshots, Playwright HTML report link.
6. **Later (optional):** MCP wrapper (`start_run`, `get_run`), Docker per job, failure-only Claude diagnosis.

## 12. Open questions

- Does dev need a redeploy of my branch before tests, or do tests target what dev already serves?
- Implementation language: Node vs Python/FastAPI. (MVP chose Node 24 for server and CLI; the suite's Python lives only in its venv, see `docs/mvp/README.md` §2.)
- How long to keep artifacts (e.g. 7 days)?
- Auto-retry of failed tests?
