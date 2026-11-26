# cloud-agent-v1

PoC HTTP service: `POST /<repo>/run-agent` with a prompt → the service pulls the latest commit of the
chosen branch of that repo and runs `claude -p` (headless, on a Claude subscription) inside it,
so the repo's own `.claude/` agents, skills and commands apply. Poll `GET /<repo>/run-agent/{id}` for the result.
Several repos can be configured; an admin dashboard at `/admin/` shows each repo's status and jobs, and its JSON API
adds, edits and removes repos.

Spec: [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md). Design notes: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
Multi-repo + dashboard design: [docs/MULTI_REPO_PLAN.md](docs/MULTI_REPO_PLAN.md).
Repos in SQLite + encrypted per-repo tokens: [docs/SQLITE_REPOS_PLAN.md](docs/SQLITE_REPOS_PLAN.md).

## Setup

Requirements: Node ≥ 22.13 (for the built-in `node:sqlite`), git ≥ 2.31, Claude Code CLI (`claude`) on `PATH`.
Run as a **non-root** user (claude refuses `bypassPermissions` as root).

```bash
npm install

# 1. Make sure this machine is logged in to your Claude subscription (once, interactive):
claude auth status          # should show "authMethod": "claude.ai"
# if not:  claude  → /login

# 2. Configure
openssl rand -base64 32           # → MASTER_KEY in .env
cp .env.example .env              # MASTER_KEY, API_KEY, ADMIN_PASSWORD, one GIT_TOKEN_<NAME> per https repo, ...
cp repos.example.json repos.json  # the target repos, imported once into the database on first start
```

### Repos (stored in SQLite)

Repos and their tokens live in a SQLite database, `DB_FILE` (default `./data/cloud-agent.db`, created with mode
0600). Tokens are encrypted with `MASTER_KEY` (see [Master key, backups, rotation](#master-key-backups-rotation)).
Repos are managed through the admin API (see [Managing repos](#managing-repos-admin-api)); changes apply
immediately, no restart.

**First-boot import.** The database is filled once from `repos.json` (path set by `REPOS_FILE`, default
`./repos.json`) plus the `GIT_TOKEN_<NAME>` env vars it names. The import runs only when the repos table is empty,
the import has never run before, and the file exists. It is atomic (any problem imports nothing and startup fails
with a list of every problem) and happens once: the log says `Imported N repos from <file>`. After that,
`repos.json` and `GIT_TOKEN_*` are ignored and only produce a startup warning; remove them. With no database and no
file, the service starts with 0 repos.

```json
{
  "repos": [
    { "id": "web", "url": "https://github.com/your-org/web.git", "defaultBranch": "dev",
      "auth": { "tokenEnv": "GIT_TOKEN_WEB" } },
    { "id": "api", "url": "git@github.com:your-org/api.git",
      "auth": { "sshKeyPath": "/run/ssh-keys/id_ed25519_api" } }
  ]
}
```

- `id`: 1–40 chars of `a-z`, `0-9`, `-`. It is the URL segment (`/web/run-agent`) and the workspace folder name.
  `admin`, `health`, `repos`, `run-agent` are reserved.
- Every remote repo has **its own credential**, with no shared fallback: https URLs need `auth.tokenEnv` (the *name*
  of an env var holding the token at import time); ssh URLs need `auth.sshKeyPath`, an absolute path inside
  `SSH_KEYS_DIR` (default `/run/ssh-keys`; for local dev set `SSH_KEYS_DIR=~/.ssh`). Local paths (`/srv/x.git`,
  `file:///...`) take none and are only allowed with `ALLOW_LOCAL_REPOS=true` (tests, local dev). The token is only
  sent to that repo's own host.
- `defaultBranch` (default `main`) is used when a job doesn't name a branch.
- Each repo is cloned to `WORKSPACE_ROOT/<id>` (default `./workspaces/<id>`) by its first job. A `workspaceRoot` in
  `repos.json` is ignored (with a warning if it differs; set `WORKSPACE_ROOT` to that path to keep existing clones).
  If a workspace turns out to be a clone of a different repo, its jobs fail with a "delete it so it is re-cloned"
  error.
- Stored repos are re-checked at every startup: an invalid one (e.g. a local repo without `ALLOW_LOCAL_REPOS`) stops
  the service; a missing ssh key file or a missing https token only warns (that repo's jobs fail).
- To add, edit, disable or delete repos, or to set a token, use the admin API. The first-boot import only fills an
  empty database.

Migrating from the single-repo version: `REPO_URL`, `REPO_BRANCH`, `WORKSPACE_DIR` and `GIT_SSH_KEY_PATH` are no
longer read (startup fails if they are set); a leftover `GIT_TOKEN` is ignored with a warning. Move the repo into
`repos.json` with its token in e.g. `GIT_TOKEN_<NAME>` referenced from `auth.tokenEnv`, and let the first boot
import it. The old `./workspace` clone is not reused; delete it, since each repo is re-cloned under
`./workspaces/<id>`.

No Claude token or API key is configured. The service uses the subscription login stored in `~/.claude` of
the OS user that runs it, so start it as **that same user** (same `HOME`). `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are stripped from claude's environment, so the machine
login is always what gets used and billed. The service's own secrets (`API_KEY`, `ADMIN_PASSWORD`,
`MASTER_KEY`, `MASTER_KEY_PREVIOUS`, every repo's `auth.tokenEnv` variable and any `GIT_TOKEN`/`GIT_TOKEN_*`)
are also removed from the environment of claude and of git; git gets the repo's token only as an origin-scoped
auth header, and always runs with `GIT_TRACE_REDACT=1`. This is not a sandbox: claude runs as the same OS user
as the service.

Repo tokens are encrypted at rest (AES-256-GCM, bound to the repo, the secret name and the repo URL's origin, so a
row copied to another repo or a URL pointed at another host no longer decrypts). Git runs with hooks and fsmonitor
disabled, credential helpers and askPass reset, only the repo's own transport allowed, and an explicit
`--upload-pack`, so a `.git/config` planted in a workspace by a job can't make the next sync run code. Known limit:
filter drivers and `http.*` overrides in a workspace's `.git/config` are not neutralised (same trust level as
claude itself, which runs as the same user).

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

### Master key, backups, rotation

`MASTER_KEY` (base64 of 32 bytes: `openssl rand -base64 32`) is required; startup fails without it, and also fails
(before the Claude probe) if a stored token can't be decrypted with `MASTER_KEY` / `MASTER_KEY_PREVIOUS`. Keep a copy
of it **outside** your backups (e.g. a password manager): a backup plus its key is a full set of tokens, and losing
the key means re-entering every token (`PUT /admin/api/repos/<id>/token`).

Back up with the built-in command, which takes a consistent copy (a plain `cp` of a live WAL database can miss
committed data). The target must not exist; it is written with mode 0600:

```bash
docker compose exec cloud-agent node src/cli.js backup /app/data/backups/$(date +%F).db   # Docker
node src/cli.js backup ./data/backups/$(date +%F).db                                      # local (reads DB_FILE)
```

Rotate the key:

1. Back up the database.
2. Put the new key in `MASTER_KEY` and the old one in `MASTER_KEY_PREVIOUS` (comma-separated if several).
3. Restart (`docker compose up -d`).
4. Startup re-encrypts every token to the new key in one transaction and logs `Re-encrypted N secret(s) to key <kid>`.
5. Remove `MASTER_KEY_PREVIOUS` (startup warns while it is set but unused) and restart.

## Deploy (Docker + VPS)

### How it fits together

The Docker image holds **only code**: the server, the built dashboard and the Claude Code CLI. Config and state are
never baked in (`.dockerignore` excludes `.env`, `repos.json`, `data`, `workspaces`). They live on the VPS and are
attached when the container starts:

| What | Where on the VPS | Container path | Who puts it there |
|---|---|---|---|
| `docker-compose.yml` | deploy dir (`/opt/cloud-agent`) | — | CI, on every deploy |
| `.env` (secrets, incl. `MASTER_KEY`) | deploy dir | env vars | **you**, once |
| `repos.json` (first-boot import only) | deploy dir (bind mount, read-only) | `/app/repos.json` | **you**, once |
| Claude login | volume `claude-home` | `/home/node` | **you**, once (`/login`) |
| repo clones | volume `workspaces` | `/app/workspaces` | the app |
| job history (`jobs.jsonl`) | volume `data` | `/app/data/jobs.jsonl` | the app |
| repos + encrypted tokens (`cloud-agent.db`) | volume `data` | `/app/data/cloud-agent.db` | the app |

So the same image runs anywhere, secrets never reach the registry, and redeploys keep the login and job history.
Don't copy your local `jobs.jsonl` or `workspaces/` to the VPS: the app creates its own.

On every push to `main`, `.github/workflows/ci-cd.yml` runs the tests and builds and pushes
`ghcr.io/<owner>/cloud-agent:<sha>` (and `:latest`). It then copies `docker-compose.yml` to the VPS over SSH and runs
`docker compose pull && docker compose up -d` there. Pull requests only run the tests.

### 1. Prepare the VPS (once)

Install Docker Engine with the compose plugin, then create a deploy user that can run Docker:

```bash
sudo adduser --disabled-password deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/cloud-agent && sudo chown deploy: /opt/cloud-agent
```

Generate an SSH key pair for CI (on your machine) and authorize it for that user:

```bash
ssh-keygen -t ed25519 -f cloud-agent-deploy -N '' -C cloud-agent-ci
ssh-copy-id -i cloud-agent-deploy.pub deploy@<vps>     # or append it to ~deploy/.ssh/authorized_keys
```

### 2. Configure GitHub (once)

In the repo, go to **Settings → Secrets and variables → Actions** and add:

| Name | Kind | Value |
|---|---|---|
| `VPS_HOST` | secret | VPS hostname or IP |
| `VPS_USER` | secret | `deploy` |
| `VPS_SSH_KEY` | secret | contents of the **private** key `cloud-agent-deploy` |
| `VPS_PORT` | secret, optional | SSH port (default `22`) |
| `DEPLOY_DIR` | variable, optional | deploy dir (default `/opt/cloud-agent`) |

Then go to **Settings → Environments** and create an environment named `production`. Add required reviewers there if
deploys should wait for approval.

### 3. Put the config on the VPS (once)

Copy the compose file and your config into the deploy dir:

```bash
scp docker-compose.yml .env repos.json deploy@<vps>:/opt/cloud-agent/
```

Inside the container, paths are container paths, not paths on your laptop. Check these before copying:

- `.env`: `PORT`, `DB_FILE`, `WORKSPACE_ROOT`, `REPOS_FILE` and `JOBS_FILE` are overridden by `docker-compose.yml`,
  so their values don't matter. Set real values for `MASTER_KEY`, `API_KEY`, `ADMIN_PASSWORD` and every
  `GIT_TOKEN_<NAME>` (needed for the first-boot import only).
- **ssh repos**: put the keys in `/opt/cloud-agent/ssh/` on the VPS, then uncomment the `./ssh:/run/ssh-keys:ro` line
  in `docker-compose.yml` and commit that change, since CI overwrites the VPS copy. Point
  `"sshKeyPath"` at `/run/ssh-keys/<key>` (keys must be under `/run/ssh-keys`, the default `SSH_KEYS_DIR`). The container runs as uid 1000, so the keys must be readable by it:
  ```bash
  sudo chown -R 1000:1000 /opt/cloud-agent/ssh && chmod 600 /opt/cloud-agent/ssh/*
  ```
  Host keys are accepted on first use and remembered in the `claude-home` volume.

If the GHCR package is private, log the VPS in to the registry once with a GitHub PAT that has `read:packages`:

```bash
echo <PAT> | docker login ghcr.io -u <github-user> --password-stdin
```

### 4. First deploy and Claude login

1. Build the first image: merge to `main`, or open **Actions → CI/CD → Run workflow** on `main`. CI pushes the image
   and starts the container. On this first run the container keeps restarting with a "not logged in" error, because
   Claude isn't logged in yet. That's expected.
2. Log in to the Claude subscription. Run this on the VPS:
   ```bash
   cd /opt/cloud-agent
   docker compose run --rm cloud-agent claude     # type /login, open the URL, paste the code, then /exit
   docker compose restart cloud-agent
   ```
   The login is saved in the `claude-home` volume, so later deploys reuse it.
3. Check that it's up:
   ```bash
   docker compose logs -f cloud-agent              # expect "Claude auth OK (...)" and "Listening on :8080"
   curl -s localhost:8080/health
   ```

### Upgrading to the SQLite repo store

For a VPS that already runs a version reading `repos.json` + `GIT_TOKEN_*` directly:

1. Add `MASTER_KEY` to `/opt/cloud-agent/.env` **before merging to `main`**; otherwise the new container exits with
   `MASTER_KEY is required` and keeps restarting.
2. Merge. Check `docker compose logs cloud-agent` for `Imported N repos from /app/repos.json`.
3. Back up the database (see [Master key, backups, rotation](#master-key-backups-rotation)).
4. Remove the `GIT_TOKEN_*` lines from `.env` and run `docker compose up -d`. Keep them until you are sure you won't
   roll back: an older image ignores the database and reads `repos.json` + `GIT_TOKEN_*`.

### 5. Expose it with TLS

The port is bound to `127.0.0.1:8080` only, so put a reverse proxy with TLS in front of it. Example with Caddy
(`/etc/caddy/Caddyfile`), which gets the certificate automatically:

```
agent.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1      # stream SSE (/<repo>/run-agent/<id>/events) without buffering
    }
}
```

The API (`x-api-key`) and the dashboard (`https://agent.example.com/admin/`, Basic auth) are then reachable over
HTTPS.

### Day-to-day operations

Run these in `/opt/cloud-agent` on the VPS:

| Task | Command |
|---|---|
| Deploy a new version | push/merge to `main` (CI does the rest) |
| Add/change a repo | `curl` the admin API (see [Managing repos](#managing-repos-admin-api)) |
| Back up repos + tokens | `docker compose exec cloud-agent node src/cli.js backup /app/data/backups/$(date +%F).db` (copy it off the VPS; keep `MASTER_KEY` separately) |
| Rotate `MASTER_KEY` | new key in `MASTER_KEY`, old in `MASTER_KEY_PREVIOUS`, `docker compose up -d`, then remove `MASTER_KEY_PREVIOUS` (see above) |
| Change `.env` | edit it, then `docker compose up -d` (`restart` does not re-read `.env`) |
| Logs | `docker compose logs -f --tail 100 cloud-agent` |
| Status | `docker compose ps` |
| Roll back | `IMAGE=ghcr.io/<owner>/cloud-agent:<old-sha> docker compose up -d` (the next CI deploy replaces it) |
| Claude login expired | repeat the `docker compose run --rm cloud-agent claude` → `/login` step, then restart |
| Look at job history | `docker compose exec cloud-agent tail -n 5 /app/data/jobs.jsonl` |
| Reset a broken clone | `docker compose exec cloud-agent rm -rf /app/workspaces/<id>` (re-cloned by the next job) |

`docker compose down` keeps the volumes. `docker compose down -v` **deletes** them, including the Claude login, the
job history and the clones.

Notes:
- A deploy or restart stops the service, so jobs that are running at that moment are marked failed.
- Claude jobs run *inside the container*. Add any toolchain the target repos need (browsers for e2e tests, python,
  ...) to the `Dockerfile`.
- To test the image locally: `docker compose build && docker compose up` (uses the `.env` and `repos.json` in the
  repo root).

## Admin dashboard

Set `ADMIN_PASSWORD` (≥ 8 chars, different from `API_KEY`) and open `http://localhost:8080/admin/`; the browser asks
for `ADMIN_USER` (default `admin`) / `ADMIN_PASSWORD`. Without `ADMIN_PASSWORD`, `/admin` does not exist (404).

The dashboard is a React + Ant Design app in `web/` (needs Node ≥ 22.22 to build; the server itself needs
Node ≥ 22.13). Build it once before starting the server — until then `/admin/` answers `503 dashboard not built`:

```bash
npm run build:web      # installs web/ deps and writes web/dist (gitignored), served by Express at /admin/
npm start
```

For UI development, run the server (`npm run dev`) and, in another terminal, `npm run dev:web`, then open
`http://localhost:5173/admin/`. Vite proxies `/admin/api` to `http://localhost:8080` (override with
`ADMIN_API_TARGET`). `npm run test:web` type-checks the app.

- **Overview:** running/queued jobs, 24h outcome counts, and a card per repo: health (`ok`, `sync error`,
  `syncing`, `never synced`), last sync (branch, commit, duration, error), whether it's cloned, what's running now,
  job counts.
- **Repo** and **Jobs:** job tables filterable by repo and status, with queue/sync/run times, cost and turns.
- **Job detail:** status timeline, prompt, result, error, full log, and the live event stream while it runs.

The pages are read-only for now (repo forms come next); repos are managed through the JSON API below.
`ADMIN_PASSWORD` is now a write credential: use ≥ 16 characters. Pages have real URLs (`/admin/jobs/<id>`, `/admin/repos/<id>?status=failed`), so they can be
bookmarked and shared. Admins can read every job's prompt, result and log. Basic auth sends the password with every
request, so put TLS (a reverse proxy) in front of anything that isn't localhost. The dashboard's JSON API is
under `/admin/api/` (`summary`, `repos`, `repos/<id>`, `jobs?repo=&status=&limit=&before=`, `jobs/<id>`,
`jobs/<id>/events`, `audit?repo=&limit=&before=`).

### Managing repos (admin API)

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/api/repos` | `{id,url,defaultBranch?,sshKeyPath?,token?}` → 201 + repo status (https needs `token`) |
| PATCH | `/admin/api/repos/<id>` | `{url?,defaultBranch?,sshKeyPath?,enabled?,token?}` → 200 |
| PUT | `/admin/api/repos/<id>/token` | `{token}` → 204, never echoed back |
| DELETE | `/admin/api/repos/<id>` | 204, or 409 |
| GET | `/admin/api/audit?repo=&limit=&before=` | `{entries, next}` |

**Required headers** on every non-GET request: `Content-Type: application/json` and `X-Admin-Request: 1`. A browser
`Origin` must match the host, and `Sec-Fetch-Site` must be `same-origin` or absent; otherwise 403. Errors are
`{"error": "..."}` (validation errors add `problems: [...]`).

**Behind a proxy:** a proxy that rewrites `Host` (nginx's default) needs `proxy_set_header Host $host;` or
`TRUST_PROXY=true` (which also makes the audit IP the real client). Only set `TRUST_PROXY` if the port is reachable
through the proxy alone (compose binds 127.0.0.1).

**Rules:**
- Disabling makes `POST /<id>/run-agent` return 409, fails that repo's queued jobs ("repo disabled") and lets a
  running job finish.
- Delete needs no queued or running jobs (disable first). It removes the repo, its token and its clone; job history
  stays.
- A URL change is refused while a job runs. A different remote wipes the clone (re-cloned by the next job). Moving to
  another host (or from ssh/local to https) needs `token` in the same PATCH, because the stored token is bound to the
  old host.
- Every change writes an audit row (`repo.create|repo.update|repo.enable|repo.disable|repo.delete|token.set`) and an
  `[audit]` log line; tokens show only as `set …a1b2`.

curl examples (keep the token out of argv and history):

```bash
A="$ADMIN_USER:$ADMIN_PASSWORD"; U=http://localhost:8080/admin/api
H=(-H 'Content-Type: application/json' -H 'X-Admin-Request: 1')
read -rs TOKEN   # paste the GitHub token, no echo
printf '{"id":"web","url":"https://github.com/your-org/web.git","defaultBranch":"dev","token":"%s"}' "$TOKEN" \
  | curl -s -u "$A" "${H[@]}" -X POST "$U/repos" --data-binary @-
curl -s -u "$A" "${H[@]}" -X POST "$U/repos" -d '{"id":"api","url":"git@github.com:your-org/api.git","sshKeyPath":"/run/ssh-keys/id_ed25519_api"}'
printf '{"token":"%s"}' "$TOKEN" | curl -s -u "$A" "${H[@]}" -X PUT "$U/repos/web/token" --data-binary @- -w '%{http_code}\n'
curl -s -u "$A" "${H[@]}" -X PATCH "$U/repos/web" -d '{"enabled":false}'
curl -s -u "$A" "${H[@]}" -X PATCH "$U/repos/web" -d '{"defaultBranch":"main"}'
curl -s -u "$A" "${H[@]}" -X DELETE "$U/repos/web" -w '%{http_code}\n'
curl -s -u "$A" "$U/audit?repo=web&limit=20"
```

(`printf` is a shell builtin, so the token never appears in `ps`.)

## API

Every job route names the repo: `/<repo>/run-agent...`, where `<repo>` is a repo `id` (see `GET /repos`). All API
routes need the `x-api-key` header; `GET /health` is unauthenticated. Unknown repo → `404 {"error":"repo not found"}`.

| Method | Path | |
|---|---|---|
| `GET` | `/repos` | `[{id, default_branch}]` |
| `POST` | `/<repo>/run-agent` | body `{prompt, branch?}` → `202 {id, status:"queued"}`; `409 {"error":"repo disabled"}` if the repo is disabled |
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
                    # Starts the real service with the project's .env and the REAL claude CLI (uses subscription);
                    # repos.json + GIT_TOKEN_* are imported into a temp DB (MASTER_KEY from .env, or a random one).
```

E2E knobs (env): `E2E_REPO=<id>` (default: first repo in `repos.json`), `E2E_BRANCHES=main,dev`,
`E2E_MARKER_CONTENT=<text>` (T5: push `MARKER.txt` with that content to the repo's `defaultBranch` first), `E2E_T7_EXPECT=<regex>`, `E2E_T8_PROMPT=<prompt that triggers a repo skill/command>`
and `E2E_T8_EXPECT=<regex>` (T8 is skipped unless `E2E_T8_PROMPT` is set), `E2E_JOB_WAIT_SECONDS=1800`.
