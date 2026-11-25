# cloud-agent-v1

PoC HTTP service: `POST /<repo>/run-agent` with a prompt → the service pulls the latest commit of the
chosen branch of that repo and runs `claude -p` (headless, on a Claude subscription) inside it,
so the repo's own `.claude/` agents, skills and commands apply. Poll `GET /<repo>/run-agent/{id}` for the result.
Several repos can be configured; a read-only admin dashboard at `/admin/` shows each repo's status and jobs.

Spec: [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md). Design notes: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
Multi-repo + dashboard design: [docs/MULTI_REPO_PLAN.md](docs/MULTI_REPO_PLAN.md).

## Setup

Requirements: Node ≥ 18.20, git ≥ 2.31, Claude Code CLI (`claude`) on `PATH`. Run as a **non-root** user
(claude refuses `bypassPermissions` as root).

```bash
npm install

# 1. Make sure this machine is logged in to your Claude subscription (once, interactive):
claude auth status          # should show "authMethod": "claude.ai"
# if not:  claude  → /login

# 2. Configure
cp .env.example .env              # API_KEY, ADMIN_PASSWORD, one GIT_TOKEN_<NAME> per https repo, ...
cp repos.example.json repos.json  # the target repos
```

### Repos (`repos.json`, path set by `REPOS_FILE`)

```json
{
  "workspaceRoot": "./workspaces",
  "repos": [
    { "id": "web", "url": "https://github.com/your-org/web.git", "defaultBranch": "dev",
      "auth": { "tokenEnv": "GIT_TOKEN_WEB" } },
    { "id": "api", "url": "git@github.com:your-org/api.git",
      "auth": { "sshKeyPath": "~/.ssh/id_ed25519_api" } }
  ]
}
```

- `id`: 1–40 chars of `a-z`, `0-9`, `-`. It is the URL segment (`/web/run-agent`) and the workspace folder name.
  `admin`, `health`, `repos`, `run-agent` are reserved.
- Every remote repo has **its own credential**, with no shared fallback: https URLs need `auth.tokenEnv` (the *name*
  of an env var holding the token, so `repos.json` holds no secrets); ssh URLs need `auth.sshKeyPath`. Local paths
  (`/srv/x.git`, `file:///...`) take none. The token is only sent to that repo's own host.
- `defaultBranch` (default `main`) is used when a job doesn't name a branch.
- Each repo is cloned to `<workspaceRoot>/<id>` (default `./workspaces/<id>`) by its first job. If a workspace turns
  out to be a clone of a different repo, its jobs fail with a "delete it so it is re-cloned" error.
- Repos are loaded at startup; edit the file and restart to add/remove one. Startup fails with a list of every
  problem in the file.

Migrating from the single-repo version: `REPO_URL`, `REPO_BRANCH`, `WORKSPACE_DIR`, `GIT_TOKEN` and
`GIT_SSH_KEY_PATH` are no longer read (startup fails if they are set). Move the repo into `repos.json`, rename
`GIT_TOKEN` to e.g. `GIT_TOKEN_<NAME>` and reference it from `auth.tokenEnv`. The old `./workspace` clone is not
reused; delete it, since each repo is re-cloned under `./workspaces/<id>`.

No Claude token or API key is configured. The service uses the subscription login stored in `~/.claude` of
the OS user that runs it, so start it as **that same user** (same `HOME`). `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are stripped from claude's environment, so the machine
login is always what gets used and billed.

At startup the service checks `claude --version`, `claude auth status` (must be logged in with
`authMethod: "claude.ai"`), and (with `CLAUDE_AUTH_PROBE=true`,
the default) runs a 1-turn probe prompt to prove the login really works. It costs a little usage per boot;
set `CLAUDE_AUTH_PROBE=false` to skip it.

## Run

```bash
npm start        # logs "Claude auth OK (...)" then "Listening on :8080"
npm run dev      # same, with node --watch
```

Ctrl-C / SIGTERM shuts down gracefully: queued jobs are marked failed, running claude process groups are killed.

### Concurrency and job history

- `MAX_CONCURRENT_JOBS` (default `1`) caps jobs running at once across all repos. A repo never runs two jobs at
  once (it has one working tree); its jobs run in submission order, and a busy repo doesn't hold up other repos.
  Parallel runs share one Claude subscription's rate limits, so raise this deliberately.
- `JOBS_FILE=./data/jobs.jsonl` keeps job history across restarts (append-only JSONL, compacted automatically).
  Jobs that were queued/running when the service stopped come back as `failed` ("Service restarted while job
  was running"). Unset = in memory only. The live event timeline is not saved; status, result and log are.
- `JOB_RETENTION_MAX` (default `1000`) finished jobs are kept; older ones are dropped. Queued/running jobs never are.

## Admin dashboard

Set `ADMIN_PASSWORD` (≥ 8 chars, different from `API_KEY`) and open `http://localhost:8080/admin/`; the browser asks
for `ADMIN_USER` (default `admin`) / `ADMIN_PASSWORD`. Without `ADMIN_PASSWORD`, `/admin` does not exist (404).

- **Overview:** running/queued jobs, 24h outcome counts, and a card per repo: health (`ok`, `sync error`,
  `syncing`, `never synced`), last sync (branch, commit, duration, error), whether it's cloned, what's running now,
  job counts.
- **Repo** and **Jobs:** job tables filterable by repo and status, with queue/sync/run times, cost and turns.
- **Job detail:** status timeline, prompt, result, error, full log, and the live event stream while it runs.

It is read-only. Admins can read every job's prompt, result and log. Basic auth sends the password with every
request, so put TLS (a reverse proxy) in front of anything that isn't localhost. The dashboard's JSON API is
under `/admin/api/` (`summary`, `repos`, `repos/<id>`, `jobs?repo=&status=&limit=&before=`, `jobs/<id>`,
`jobs/<id>/events`).

## API

Every job route names the repo: `/<repo>/run-agent...`, where `<repo>` is an `id` from `repos.json`. All API
routes need the `x-api-key` header; `GET /health` is unauthenticated. Unknown repo → `404 {"error":"repo not found"}`.

| Method | Path | |
|---|---|---|
| `GET` | `/repos` | `[{id, default_branch}]` |
| `POST` | `/<repo>/run-agent` | body `{prompt, branch?}` → `202 {id, status:"queued"}` |
| `GET` | `/<repo>/run-agent?status=&limit=&before=` | `{jobs:[summary…], next}`, newest first; `next` is the `before` cursor of the next page |
| `GET` | `/<repo>/run-agent/{id}` | the job (404 if it belongs to another repo) |
| `GET` | `/<repo>/run-agent/{id}/events` | live progress (SSE) |

```bash
API_KEY=change-me
REPO=web

curl -s -H "x-api-key: $API_KEY" localhost:8080/repos

# submit (returns 202 {"id":"job_...","status":"queued"}); branch defaults to the repo's defaultBranch
ID=$(curl -s -X POST localhost:8080/$REPO/run-agent \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"Please use test agent to test e2e test suite of feature A"}' | jq -r .id)

# optional branch override
curl -s -X POST localhost:8080/$REPO/run-agent \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"say hello","branch":"main"}'

# poll: status is queued | pulling | running | succeeded | failed | timeout
curl -s -H "x-api-key: $API_KEY" localhost:8080/$REPO/run-agent/$ID | jq '{status,repo_id,commit,result,error}'

# full log tail of a job
curl -s -H "x-api-key: $API_KEY" localhost:8080/$REPO/run-agent/$ID | jq -r .logs_tail

# recent failed jobs of this repo
curl -s -H "x-api-key: $API_KEY" "localhost:8080/$REPO/run-agent?status=failed,timeout&limit=10" | jq '.jobs[] | {id,error_preview}'

# live progress (Server-Sent Events); -N disables curl's buffering
curl -N -H "x-api-key: $API_KEY" localhost:8080/$REPO/run-agent/$ID/events
```

### Live progress (SSE)

`GET /<repo>/run-agent/{id}/events` streams what the agent is doing while the job runs. Frames look like
`id: 7\nevent: tool_use\ndata: {"id":"toolu_..","name":"Bash","input":{...}}`. Event types:

| event | data |
|---|---|
| `status` | `{status, from}` on every transition |
| `log` | `{line}` — git / stderr / `[claude]` lines (same as `logs_tail`) |
| `init` | `{session_id, model, tools}` |
| `assistant_text` | `{text, truncated}` |
| `thinking` | `{text, truncated, redacted}` — only when the model emits thinking; may be summarized/redacted |
| `tool_use` | `{id, name, input}` |
| `tool_result` | `{tool_use_id, is_error, text, truncated}` (text clipped to 4000 chars) |
| `result` | `{status, result, error, claude}` — **terminal**: the server closes the stream after it |
| `gap` | `{dropped}` — events evicted from the 2000-event buffer before you (re)connected |

Reconnect with `Last-Event-ID: <last id>` (or `?since=<id>`) to resume without losing events; a finished
job replays its buffered events and closes (for older finished jobs only the final `result` event is kept). Browsers' `EventSource` cannot send the `x-api-key` header, so
use `fetch` with a streaming reader (or `@microsoft/fetch-event-source`):

```js
const res = await fetch(`/${repo}/run-agent/${id}/events`, { headers: { 'x-api-key': KEY } });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
// split on "\n\n", parse `event:` / `data:` lines
```

If you put a reverse proxy in front, disable response buffering (the service already sends `X-Accel-Buffering: no`).

## Tests

```bash
npm test            # unit + integration: fake claude (test-support/fake-claude.js) + local bare git repos.
                    # No network, no real claude, no subscription usage.

npm run test:e2e    # = E2E=1 node --test test/e2e.test.js
                    # Starts the real service with the project's .env + repos.json and the REAL claude CLI (uses subscription).
```

E2E knobs (env): `E2E_REPO=<id>` (default: first repo in `repos.json`), `E2E_BRANCHES=main,dev`,
`E2E_MARKER_CONTENT=<text>` (T5: push `MARKER.txt` with that content to the repo's `defaultBranch` first), `E2E_T7_EXPECT=<regex>`, `E2E_T8_PROMPT=<prompt that triggers a repo skill/command>`
and `E2E_T8_EXPECT=<regex>` (T8 is skipped unless `E2E_T8_PROMPT` is set), `E2E_JOB_WAIT_SECONDS=1800`.
