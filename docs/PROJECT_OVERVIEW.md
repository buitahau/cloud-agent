# Cloud Agent v1 — Project Overview

> This is the original single-repo spec. The service has since been extended to several repos
> (`POST /<repo>/run-agent`, repos stored in SQLite, see [SQLITE_REPOS_PLAN.md](SQLITE_REPOS_PLAN.md)) and an admin dashboard; see
> [MULTI_REPO_PLAN.md](MULTI_REPO_PLAN.md) and the [README](../README.md) for the current API and configuration.

## 1. Purpose

This project is a **proof of concept (PoC)**. Its goal is to show that the following idea works end to end:

> A remote service takes a plain-text prompt over HTTP, pulls the latest code of a target repository, runs Claude Code (logged in with a Claude subscription) against that code with the prompt, and lets the caller poll for the result.

The target repository already holds its own Claude Code setup under `./.claude/` (agents, skills, workflows, commands). This service does not define *what* gets done. It runs the repository's own Claude setup on demand, against fresh code.

### Example

A caller sends:

```
POST /run-agent
{ "prompt": "Please use test agent to test e2e test suite of feature A" }
```

The service:

1. Pulls the latest changes on the configured branch (for example `main` or `dev`).
2. Runs `claude -p "<prompt>"` inside the repository.
3. Claude finds the `test` agent in `.claude/agents/`, and that agent runs feature A's e2e suite.
4. The caller polls `GET /run-agent/{id}` until the job is `succeeded` or `failed`, then reads the output.

---

## 2. Core Idea

| # | Idea |
|---|------|
| 1 | A **cloud / remote agent system** with a `POST /run-agent` endpoint. The payload is the prompt. It returns a job **id** right away, and the job runs asynchronously. |
| 2 | A **status-polling API** that takes that id and returns the job's status and result. |
| 3 | On each prompt, the system **pulls the latest commit** of the configured branch (`main` or `dev`) before running anything. |
| 4 | The prompt runs with **`claude -p`** (headless / print mode), using a **Claude subscription** that is already logged in. No API key is needed. |
| 5 | The target repo already has **agents / skills / workflows under `./.claude/`**. Claude picks them up automatically because it runs inside the repo. |
| 6 | Configuration comes from an **`.env` file**: repo URL, branch, and so on. |
| 7 | When the system starts, it **uses the stored credential to start the Claude subscription session**, then acts as an **orchestrator**: receive prompt → pull → run Claude → store result. |

---

## 3. Architecture

```
 ┌──────────┐   POST /run-agent {prompt}    ┌────────────────────────────────────┐
 │  Caller  │ ────────────────────────────▶ │         Orchestrator (API)         │
 │ (CI, UI, │ ◀──── { id, status:queued } ─ │                                    │
 │  human)  │                               │  ┌──────────┐    ┌───────────────┐ │
 │          │   GET /run-agent/{id}         │  │ Job store│◀──▶│  Job worker   │ │
 │          │ ────────────────────────────▶ │  │ (memory/ │    │               │ │
 │          │ ◀── { status, result, ... } ─ │  │  sqlite) │    │ 1. git fetch  │ │
 └──────────┘                               │  └──────────┘    │    + reset    │ │
                                            │                  │ 2. claude -p  │ │
                                            │                  │ 3. save output│ │
                                            │                  └───────┬───────┘ │
                                            └──────────────────────────┼─────────┘
                                                                       │
                                                       ┌───────────────▼──────────────┐
                                                       │  Local clone of target repo  │
                                                       │  ├── .claude/agents/*.md     │
                                                       │  ├── .claude/skills/...      │
                                                       │  ├── .claude/commands/...    │
                                                       │  └── src/, tests/e2e/ ...    │
                                                       └──────────────────────────────┘
```

### Components

- **API server**: exposes `POST /run-agent` and `GET /run-agent/{id}`.
- **Job store**: keeps job state (in memory is fine for the PoC; SQLite if jobs must survive restarts).
- **Job worker**: runs jobs one at a time (or in parallel, see §7). For each job it syncs the repo and then runs Claude.
- **Workspace**: a local clone of `REPO_URL`.
- **Claude Code CLI**: installed on the host and authenticated with the subscription.

---

## 4. Configuration (`.env`)

```dotenv
# Target repository
REPO_URL=git@github.com:your-org/your-repo.git   # or https://... with a token
REPO_BRANCH=dev                                  # branch to pull before every run (main | dev | ...)
WORKSPACE_DIR=./workspace                        # where the repo is cloned

# Git auth (pick one)
GIT_SSH_KEY_PATH=~/.ssh/id_ed25519               # for SSH URLs
# GIT_TOKEN=ghp_xxx                              # for HTTPS URLs

# Claude auth: nothing to configure. Uses the subscription already logged in on this machine
# (`claude` → /login, once, as the OS user running the service).

# Claude run options
CLAUDE_PERMISSION_MODE=bypassPermissions         # non-interactive: no one is there to approve tool calls
CLAUDE_MAX_TURNS=50
JOB_TIMEOUT_SECONDS=1800

# Server
PORT=8080
API_KEY=change-me                                # protects the endpoints
```

> **About the subscription login.** `claude -p` starts a fresh process for every prompt; there is no long-lived Claude session to keep open. What "starting the subscription at boot" means in practice: on startup the orchestrator checks that this machine is logged in to the Claude subscription (the `~/.claude` login of the OS user running the service, `authMethod: "claude.ai"`), and fails fast if it is not. Every job after that reuses the same login. No token or API key is configured; token/API-key env vars are stripped so the machine login is always used.

---

## 5. API Contract

### `POST /run-agent`

Request:

```json
{
  "prompt": "Please use test agent to test e2e test suite of feature A",
  "branch": "dev"          // optional, overrides REPO_BRANCH
}
```

Response `202 Accepted`:

```json
{ "id": "job_01HZX...", "status": "queued" }
```

### `GET /run-agent/{id}`

Response `200 OK`:

```json
{
  "id": "job_01HZX...",
  "status": "running",          // queued | pulling | running | succeeded | failed | timeout
  "prompt": "Please use test agent ...",
  "branch": "dev",
  "commit": "a1b2c3d",          // HEAD commit the job ran against
  "created_at": "2026-11-25T10:00:00Z",
  "started_at": "2026-11-25T10:00:02Z",
  "finished_at": null,
  "result": null,               // Claude's final text output when done
  "error": null,
  "logs_tail": "..."            // optional: last N lines of output
}
```

`404` for an unknown id.

---

## 6. Job Lifecycle

```
queued ──▶ pulling ──▶ running ──▶ succeeded
              │           │
              └──▶ failed ◀┘  (git error, claude exit≠0)
                          └──▶ timeout (JOB_TIMEOUT_SECONDS exceeded)
```

What the worker does for each job:

```bash
# 1. Sync repo (clone on first run)
[ -d "$WORKSPACE_DIR/.git" ] || git clone "$REPO_URL" "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"
git fetch origin "$BRANCH"
git checkout -f "$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -fdx -e node_modules     # drop leftovers from the previous run
git rev-parse --short HEAD         # record commit

# 2. Run Claude headless inside the repo
claude -p "$PROMPT" \
  --output-format json \
  --permission-mode "$CLAUDE_PERMISSION_MODE" \
  --max-turns "$CLAUDE_MAX_TURNS"

# 3. Parse JSON output → store result / is_error / cost / session_id on the job
```

Running Claude with the repo as its working directory makes it load `.claude/agents`, `.claude/skills`, `.claude/commands`, `.claude/settings.json`, and `CLAUDE.md` automatically.

---

## 7. Design Decisions & Open Questions

| Topic | PoC decision | Later |
|-------|--------------|-------|
| Concurrency | **One job per repo at a time** (one clone per repo), at most `MAX_CONCURRENT_JOBS` overall (default 1 = one at a time, FIFO). Two jobs in the same folder would interfere. | One `git worktree` per job, so jobs on the same repo can run in parallel. |
| Permissions | `bypassPermissions`, because nobody is present to approve tool calls. Run it in a container or VM. | Restrict with `--allowedTools` / `.claude/settings.json` allow-lists. |
| Persistence | Job state in memory, optionally saved to a JSONL file (`JOBS_FILE`) so history survives restarts. | SQLite / Postgres; store full transcripts. |
| Auth on API | One static `API_KEY` header; the admin dashboard has its own Basic-auth password. | Proper auth / per-user tokens. |
| Output | Final `result` text, plus live progress over SSE (`GET /run-agent/:id/events`) from `--output-format stream-json`. Events are kept in memory (last 2000 per job). | Persist transcripts; webhooks. |
| Subscription usage | Use the subscription already logged in on this machine. | Check that automated, shared use fits your plan's terms; switch to an API key (`ANTHROPIC_API_KEY`) or a Team/Enterprise plan for production. |

---

## 8. PoC Test Plan

The PoC is **proven** when every test below passes.

### Preconditions

- The target repo has `.claude/agents/test.md` (a "test" agent) and an e2e suite for feature A that it knows how to run.
- `.env` is filled in, and `claude -p "say hi"` works on the host without a login prompt.

### Test cases

| ID | Scenario | Steps | Expected result |
|----|----------|-------|-----------------|
| T1 | **Startup auth check** | Start the service with a valid token, then again with an invalid or missing token. | Valid: the server starts and logs "Claude auth OK". Invalid: the server exits with a clear error. |
| T2 | **Submit prompt returns id** | `POST /run-agent {"prompt":"say hello"}` | `202` with `{id, status:"queued"}`, returned in under 1s (not blocked by the run). |
| T3 | **Polling status** | Poll `GET /run-agent/{id}` every 2s. | The status moves `queued → pulling → running → succeeded`; `result` is filled in at the end. |
| T4 | **Unknown id** | `GET /run-agent/does-not-exist` | `404`. |
| T5 | **Pulls latest code** | Push a new commit to `REPO_BRANCH` (e.g. add a file `MARKER.txt`). Then submit `"What is the content of MARKER.txt?"` | `commit` matches the new HEAD, and `result` contains the file's content. |
| T6 | **Branch selection** | Set `REPO_BRANCH=main`, then `dev` (or send `branch` in the payload). | Each job reports the matching branch and commit. |
| T7 | **Repo agent is used** ⭐ | `POST /run-agent {"prompt":"Please use test agent to test e2e test suite of feature A"}` | Claude calls the `test` subagent from `.claude/agents/`, the feature A e2e tests run, and `result` summarizes pass/fail. |
| T8 | **Repo skill / command is used** | Submit a prompt that triggers a skill or slash command defined in `.claude/`. | That skill or command runs (visible in the output or logs). |
| T9 | **Failure is reported** | Submit a prompt whose run fails (e.g. a broken e2e test), or point `REPO_URL` at a bad URL. | Job ends `failed`; `error` and `logs_tail` explain why. The service stays up. |
| T10 | **Timeout** | Set `JOB_TIMEOUT_SECONDS=10` and submit a long task. | Job ends `timeout`; the Claude process is killed. |
| T11 | **Sequential jobs** | Submit 3 prompts back to back. | All 3 get ids right away, run one after another, and all finish; there are no git conflicts. |
| T12 | **Clean workspace** | Job 1 creates junk files; job 2 then runs. | Job 2 starts from a clean `origin/<branch>` checkout. |

### Manual smoke test

```bash
# submit
ID=$(curl -s -X POST localhost:8080/run-agent \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"Please use test agent to test e2e test suite of feature A"}' | jq -r .id)

# poll
watch -n 2 "curl -s -H 'x-api-key: $API_KEY' localhost:8080/run-agent/$ID | jq '{status,commit,result}'"
```

---

## 9. Definition of Done (PoC)

- [ ] `POST /run-agent` returns a job id without blocking.
- [ ] `GET /run-agent/{id}` reports status and the final result.
- [ ] Every job runs against the **latest commit** of the configured branch.
- [ ] Claude runs **headless with the subscription credential**; no API key is needed.
- [ ] Agents, skills, and workflows in the repo's `.claude/` folder are **used by the prompt** (test T7 passes).
- [ ] Failures and timeouts are reported cleanly, and the service keeps running.
