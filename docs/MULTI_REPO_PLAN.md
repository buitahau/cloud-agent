# Plan: Multi-repo support + admin dashboard

Status: **implemented**. Proposal produced by an Opus planning pass over the codebase at commit 31413b8; the
decisions below (§0) override the proposal where they differ. Current usage is documented in the README.

## 0. Decisions taken (and how they changed the proposal)

| # | Question | Decision |
|---|---|---|
| 1 | Credential fallback | **Each repo has its own credential.** https repos must set `auth.tokenEnv`, ssh repos `auth.sshKeyPath`; local paths take none. No global `GIT_TOKEN` fallback. |
| 2 | `MAX_CONCURRENT_JOBS` default | **1.** |
| 3 | Naming the repo | **Always in the path**: `POST /<repo>/run-agent`, `GET /<repo>/run-agent[?status=&limit=&before=]`, `GET /<repo>/run-agent/:id`, `GET /<repo>/run-agent/:id/events`. No body `repo` field, no `defaultRepo`, no un-prefixed `/run-agent`. A job is only visible under its own repo. Ids `admin`, `health`, `repos`, `run-agent` are reserved. |
| 4 | Persistence | On in `.env.example` (`JOBS_FILE=./data/jobs.jsonl`), off when unset; keep 1000 finished jobs. |
| 5 | Admin auth | Separate `ADMIN_PASSWORD` (≥ 8 chars, ≠ `API_KEY`), HTTP Basic. |
| 6 | Admin actions | Read-only. |
| 7 | Per-repo Claude overrides | Not added. |
| 8 | Existing `./workspace` | **Re-clone.** Every repo lives at `<workspaceRoot>/<id>`; there is no per-repo `workspaceDir` override. |

Consequences: the single-repo "legacy mode" in §2 was **not** built. `REPOS_FILE` (default `./repos.json`) is
required, and setting `REPO_URL`, `REPO_BRANCH`, `WORKSPACE_DIR`, `GIT_TOKEN` or `GIT_SSH_KEY_PATH` fails startup
with a migration hint (unless a repo names that variable as its `auth.tokenEnv`). `createWorker` still accepts the
old `{ gitSync, workspaceDir }` form (as repo `default`) so unit tests can use it.

Constraints kept: no new dependencies, `engines: >=18.20`.

---

## 1. How it works today (single-repo assumptions)

- **Config** — `src/config.js:96-111` reads one `REPO_URL` (required), `REPO_BRANCH`, `WORKSPACE_DIR`, `GIT_SSH_KEY_PATH`, `GIT_TOKEN` as flat fields. `REPO_URL` itself is not validated.
- **Git sync** — `createGitSync` (`src/gitSync.js:72-140`) is bound to one URL + one workspace. Nothing checks that an existing workspace is a clone of the configured repo (known gap, `IMPLEMENTATION_PLAN.md §8`). The token header is sent to any `https://` host (`gitSync.js:163`).
- **Wiring** — `src/index.js:83-97` builds one gitSync, one runner, one worker.
- **Worker** — `src/worker.js:2`: "exactly one job runs at a time against the single workspace". Single queue + `current`/`currentAbort`.
- **Job store** — in-memory `Map`, no eviction (each job can hold ~8 MB worst case). No repo field, no per-phase timestamps. `list()` is unused.
- **Auth** — one `API_KEY` via `x-api-key` header; `/health` open.
- **SSE** — inline handler at `server.js:105-156`; requires `x-api-key`, so browsers can't use `EventSource`.

---

## 2. Repo registry

**Recommendation: JSON file (`REPOS_FILE`) + legacy env fallback. No API for adding/removing repos.**

Why not an admin API to manage repos: it needs its own storage, makes repo URLs user input (`ext::sh -c …` = RCE in git), introduces remove-while-running races, and moves secrets over HTTP.

- **Legacy mode** (no `REPOS_FILE`): one repo built from the old env vars, id = `REPO_ID ?? 'default'`, workspace = `WORKSPACE_DIR` exactly (existing `./workspace` keeps working). Flat config fields stay populated so existing tests don't change.
- Setting both `REPOS_FILE` and `REPO_URL` → `ConfigError`.

```json
{
  "workspaceRoot": "./workspaces",
  "defaultRepo": "web",
  "repos": [
    { "id": "web", "url": "https://github.com/org/web.git", "defaultBranch": "dev",
      "auth": { "tokenEnv": "GIT_TOKEN_WEB" } },
    { "id": "api", "url": "git@github.com:org/api.git", "defaultBranch": "main",
      "auth": { "sshKeyPath": "~/.ssh/id_api" } },
    { "id": "legacy", "url": "https://github.com/org/old.git", "workspaceDir": "./workspace" }
  ]
}
```

- **Repo ids**: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`, unique; job field `repo_id`.
- **Workspaces**: `<workspaceRoot>/<id>` unless overridden. Must be absolute, must not overlap another repo's workspace, and must not be the service directory or a parent of it (`git clean -fdx` would wipe the service).
- **Credentials**: `auth.sshKeyPath` or `auth.tokenEnv` (name of an env var; the value stays in `.env`, so `repos.json` is committable). No fallback to global `GIT_TOKEN` in file mode. `redactConfig` masks `repos[].token`.
- **New env vars**: `REPOS_FILE`, `REPO_ID`, `MAX_CONCURRENT_JOBS`, `JOBS_FILE`, `JOB_RETENTION_MAX`, `ADMIN_USER`, `ADMIN_PASSWORD`.
- **Validators** (`src/lib/validate.js`): `isValidRepoId`, `validateRepoUrl` (accept https / ssh / scp-style / file / absolute path; reject `<helper>::`, leading `-`, embedded `user:pass@`, `http://`, whitespace/control chars, >2000 chars), `repo` in `validateRunAgentBody`, `validateJobListQuery` (`repo`, `status` list, `limit` 1–200 default 50, `before` cursor).

---

## 3. Concurrency & isolation

**Recommendation: one clone per repo, per-repo lock, global cap `MAX_CONCURRENT_JOBS` (default 1).**

- Max one job per repo at a time (same guarantee as today). Default 1 = today's strict FIFO; raise deliberately (parallel `claude` runs share one subscription's rate limits).
- Scheduler: global FIFO; skip ahead past jobs whose repo is busy, so per-repo order is FIFO.

```
pump(): for (i = 0; i < queue.length && running.size < max; ) {
          job = store.get(queue[i]); if (!job) { queue.splice(i,1); continue }
          if (busyRepos.has(job.repo_id)) { i++; continue }
          queue.splice(i,1); start(job)
        }
start → processJob(perRepoDeps, id, signal).finally(() => { release; notifyIdle(); setImmediate(pump) })
```

- `processJob(deps, id, signal)` unchanged — deps are built per job with that repo's `gitSync`/`workspaceDir`.
- `createWorker` stays backward compatible: old `{ gitSync, workspaceDir }` → one-repo registry `default`. Existing worker tests run unedited.
- Worker API: `queueLength(repoId?)`, `runningJobIds()`, `currentJobId()` (compat), `onIdle()`, `shutdown()` aborts all, `stats()`.
- Job for an unknown repo → `failed` with `unknown repo "<id>"`.
- `claudeRunner` shared; one `gitSync` per repo.
- **Separate clones, not worktrees**: repos need separate clones anyway; worktrees add prune/lock cleanup, lose the per-tree `node_modules` cache, and only help for parallel jobs on the *same* repo (future work).
- **Ownership check** in gitSync: `git remote get-url origin` must match the configured URL (normalized), else `GitSyncError('validate', …)`. Closes the known gap.

---

## 4. Job model & API

- `store.create({ prompt, branch, repoId = 'default' })`; `repo_id` in `toPublic` (before `branch`).
- `history: [{ status, at }]` appended in `transition` → derive queue / sync / run durations.
- Helpers: `query({ repoId?, statuses?, limit, before? }) → { jobs, next }` newest-first; `toSummary(job)`; `readLog(id)`.
- **Retention** (memory is unbounded today): `JOB_RETENTION_MAX` (1000) evicts oldest *finished* jobs; `EVENT_RETENTION_JOBS` (50) frees event rings of older finished jobs, leaving a synthetic `result` so SSE replays and closes.

| Method / path | Change |
|---|---|
| `POST /run-agent` | Body `{ prompt, repo?, branch? }`. Unknown repo → 400. No repo + no default → 400 `repo is required (one of: …)`. Branch defaults per repo. Response stays `202 { id, status }`. |
| `GET /run-agent/:id` | + `repo_id` |
| `GET /run-agent/:id/events` | unchanged |
| `GET /repos` (new) | `[{ id, default_branch }]` — no URLs/paths |
| `GET /run-agent?repo=&status=&limit=&before=` (optional) | `{ jobs, next }` |

---

## 5. Persistence

**Recommendation: optional append-only JSONL (`JOBS_FILE=./data/jobs.jsonl`), no dependency.**

- New `src/jobPersistence.js`: `load()`, `append(snapshot)`, `compact(jobs)`. Store calls `onPersist` on create + every transition (~5 writes/job; logs/events never). Final snapshot includes full log + claude metadata. `appendFileSync`; failures logged, never break a job.
- On startup `store.hydrate()`: last line per id wins; partial trailing line skipped; non-terminal jobs → `failed` ("Service restarted while job was <status>"); compact via temp file + rename; recompact at 2× retention.
- Unset `JOBS_FILE` = in-memory (tests unchanged); `.env.example` turns it on.
- Rejected `node:sqlite`: needs Node ≥ 22.13 and is experimental — not worth bumping `engines` for a PoC.
- Live tool-call events are not persisted (log + result are).

---

## 6. Admin dashboard

**Delivery**: static HTML + vanilla JS via `express.static` at `src/admin/public/{index.html,app.js,style.css}`. No build, no inline scripts (strict CSP). Hash routing. Lists poll every 5 s; job detail uses SSE.

> **Superseded:** the dashboard was rewritten in React + Ant Design (`web/`, clean `/admin/...` URLs). See [REACT_ADMIN_PLAN.md](REACT_ADMIN_PLAN.md).

**Views**
1. **Overview `#/`** — totals (queued, running/max, 24h counts by status, uptime, persistence on/off); one card per repo: health badge (`ok` / `sync error` / `never synced` / `not cloned`), last sync (time, commit, branch, duration), last error, counts, running job, queue depth.
2. **Repo `#/repos/:id`** — card + workspace path; job table with status filter + cursor paging (id, status, branch, commit, created, queue/sync/run, cost, turns, prompt preview).
3. **Jobs `#/jobs?repo=&status=`** — same table across repos.
4. **Job detail `#/jobs/:id`** — metadata, timing timeline, prompt/result/error, full log, live event list via SSE until `result`.

**Repo health is derived from jobs** (last job that entered `pulling`: next status `running` = OK, `failed` = sync error) + `fs.existsSync(<ws>/.git)`. No extra state; survives restarts via the jobs file.

| Admin endpoint (`/admin`, admin auth, `Cache-Control: no-store`) | Response |
|---|---|
| `GET /admin/` | static app |
| `GET /admin/api/summary` | `{ uptime_s, max_concurrent, queued, running, counts, persistence }` |
| `GET /admin/api/repos` | per repo: id, url_display, default_branch, workspace_dir, cloned, health, last_sync, counts, running_job_id, queued, last_job |
| `GET /admin/api/repos/:id` | above + `recent_jobs` (20); 404 if unknown |
| `GET /admin/api/jobs?repo=&status=&limit=&before=` | `{ jobs, next }` |
| `GET /admin/api/jobs/:id` | `toPublic` + `history`, `log`, `events_buffered` |
| `GET /admin/api/jobs/:id/events` | same SSE stream |

- **SSE reuse**: extract `createSseHandler({ store, openStreams, heartbeatMs, maxBuffered })` from `server.js:105-156`; mount on both paths; shared `openStreams` so shutdown closes all.
- **Admin auth**: HTTP Basic with `ADMIN_USER` (default `admin`) / `ADMIN_PASSWORD`, constant-time compare. Browser handles the prompt and resends creds — including for `EventSource`. `ADMIN_PASSWORD` unset → `/admin` not mounted (404). Refuse to start if `ADMIN_PASSWORD === API_KEY`.
- **Read-only** for now. Any future POST action needs `Origin`/`Sec-Fetch-Site` + custom-header CSRF checks.
- Headers: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. TLS via reverse proxy.

---

## 7. Security checklist

1. Validate repo URLs; set `GIT_ALLOW_PROTOCOL=https:ssh:file` in `buildGitEnv` (confirm local-path fixtures still work).
2. Tokens only via `tokenEnv`; no global fallback; optionally scope header to `http.<scheme://host/>.extraHeader`.
3. Path safety: restricted ids, workspace checks from §2; ids from URLs are map lookups only.
4. Workspace origin ownership check.
5. Admin auth as in §6.
6. **Dashboard XSS**: prompts/logs/tool output are untrusted — render only with `textContent`/`createElement`, never `innerHTML`.
7. `/health` stays minimal (no repo list).
8. Document that admins can read all prompts and results.

---

## 8. Testing plan

| File | Tests |
|---|---|
| `test/validate.test.js` | `isValidRepoId`, `validateRepoUrl` accept/reject matrix, `repo` in body, `validateJobListQuery` |
| `test/config.test.js` | legacy → repo `default` with flat fields intact; `REPOS_FILE` loads; duplicates, overlapping workspaces, cwd/parent workspace, unset `tokenEnv`, bad URL, both modes set, unknown `defaultRepo` → single `ConfigError` listing all; no token leakage; redaction |
| `test/gitSync.test.js` | two fixtures independent; origin mismatch; `GIT_ALLOW_PROTOCOL` + scoped header; T5/T6/T9/T12 still pass |
| `test/jobStore.test.js` | `repo_id`, `history`, key order, `query` filters/order/cursor, retention, event-ring eviction, `onPersist`, `hydrate` |
| `test/jobPersistence.test.js` (new) | last-line-wins, partial line ignored, atomic compaction, write errors don't throw |
| `test/worker.test.js` | existing tests unedited; (a) 2 repos max=2 overlap; (b) 1 repo max=2 serial; (c) A1,A2,B1 max=2 → A1‖B1, A2 waits; (d) max=1 strict FIFO; (e) shutdown aborts all; (f) unknown repo fails; real-git cwd check via `[[fake:pwd]]` |
| `test/server.test.js` | repo resolution/400s, per-repo branch default, exact 202 keys, `GET /repos`, SSE after refactor; admin: 404 without password, 401 + `WWW-Authenticate`, `x-api-key` not accepted, response shapes, admin SSE, headers, static served behind auth |
| `test/startup.test.js` | extend `cleanEnv`; start with `REPOS_FILE`; both modes → exit 1; persistence survives restart |
| `test/e2e.test.js` | unchanged; optional `E2E_REPO` |

Dashboard UI: manual smoke checklist in README.

---

## 9. Docs to update

README, `.env.example`, new `repos.example.json`, `docs/architecture/ARCHITECTURE.md`, `docs/architecture/diagram/sequence-diagram.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROJECT_OVERVIEW.md` (§4, §5, §7; new T13 multi-repo isolation, T14 admin auth).

---

## 10. Implementation order (each step keeps `npm test` green)

1. **Validators** — `src/lib/validate.js` + tests.
2. **Config registry** — `src/config.js`, `repos.example.json`, `.env.example` + tests.
3. **gitSync hardening** — protocol allowlist, origin check, scoped header + tests.
4. **jobStore** — `repo_id`, history, query, retention, `onPersist`, `hydrate` + tests.
5. **Repo registry** — new `src/repoRegistry.js` (`get/list/ids/defaultId/status`) + tests.
6. **Worker scheduler** — per-repo lock, global cap, skip-ahead FIFO, compat constructor + tests (a)–(f).
7. **Server + wiring** — repo resolution, `GET /repos`, `createSseHandler`, `index.js` → **multi-repo shippable here.**
8. **Persistence** — `src/jobPersistence.js` + restart test.
9. **Admin API + auth** — `src/admin.js` (`createAdminRouter`) + tests.
10. **Dashboard UI** — `src/admin/public/*`; manual check incl. `<img onerror>` prompt rendering as text.
11. **Docs.**

---

## 11. Open decisions

1. **Token fallback** in file mode to global `GIT_TOKEN`/`GIT_SSH_KEY_PATH`? Recommended: no.
2. **`MAX_CONCURRENT_JOBS` default**: 1 (recommended) or ≥2?
3. **`repo` in POST** with several repos: always required, or allow `defaultRepo`?
4. **Persistence**: on in `.env.example` (recommended)? Retention count (default 1000)?
5. **Admin auth**: separate Basic-auth password (recommended) vs. reuse `API_KEY`?
6. **Admin actions**: read-only now (recommended) vs. cancel / re-run / sync-now (needs CSRF + worker cancel path)?
7. **Per-repo Claude overrides** (`maxTurns`, `permissionMode`, timeout): out for now (recommended)?
8. **Existing `./workspace`**: keep via legacy mode / `workspaceDir`, or re-clone under `./workspaces/<id>`?
