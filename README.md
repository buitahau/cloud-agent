# cloud-agent-v1

PoC HTTP service: `POST /run-agent` with a prompt → the service pulls the latest commit of the
configured branch of a target repo and runs `claude -p` (headless, on a Claude subscription) inside it,
so the repo's own `.claude/` agents, skills and commands apply. Poll `GET /run-agent/{id}` for the result.

Spec: [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md). Design notes: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Setup

Requirements: Node ≥ 18.20, git ≥ 2.31, Claude Code CLI (`claude`) on `PATH`. Run as a **non-root** user
(claude refuses `bypassPermissions` as root).

```bash
npm install

# 1. Make sure this machine is logged in to your Claude subscription (once, interactive):
claude auth status          # should show "authMethod": "claude.ai"
# if not:  claude  → /login

# 2. Configure
cp .env.example .env
#    - REPO_URL / REPO_BRANCH / WORKSPACE_DIR
#    - GIT_SSH_KEY_PATH (ssh URL) or GIT_TOKEN (https URL)
#    - API_KEY=<any secret; callers send it as x-api-key>
```

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

Ctrl-C / SIGTERM shuts down gracefully: queued jobs are marked failed, the running claude process group is killed.

## API

All `/run-agent` routes need the `x-api-key` header. `GET /health` is unauthenticated.

```bash
API_KEY=change-me

# submit (returns 202 {"id":"job_...","status":"queued"})
ID=$(curl -s -X POST localhost:8080/run-agent \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"Please use test agent to test e2e test suite of feature A"}' | jq -r .id)

# optional branch override
curl -s -X POST localhost:8080/run-agent \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"say hello","branch":"main"}'

# poll: status is queued | pulling | running | succeeded | failed | timeout
curl -s -H "x-api-key: $API_KEY" localhost:8080/run-agent/$ID | jq '{status,commit,result,error}'
watch -n 2 "curl -s -H 'x-api-key: $API_KEY' localhost:8080/run-agent/$ID | jq '{status,commit,result}'"

# full log tail of a job
curl -s -H "x-api-key: $API_KEY" localhost:8080/run-agent/$ID | jq -r .logs_tail

# live progress (Server-Sent Events); -N disables curl's buffering
curl -N -H "x-api-key: $API_KEY" localhost:8080/run-agent/$ID/events
```

Jobs run one at a time (FIFO) against a single workspace and are kept in memory only (lost on restart).

### Live progress (SSE)

`GET /run-agent/{id}/events` streams what the agent is doing while the job runs. Frames look like
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
job replays its buffered events and closes. Browsers' `EventSource` cannot send the `x-api-key` header, so
use `fetch` with a streaming reader (or `@microsoft/fetch-event-source`):

```js
const res = await fetch(`/run-agent/${id}/events`, { headers: { 'x-api-key': KEY } });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
// split on "\n\n", parse `event:` / `data:` lines
```

If you put a reverse proxy in front, disable response buffering (the service already sends `X-Accel-Buffering: no`).

## Tests

```bash
npm test            # unit + integration: fake claude (test-support/fake-claude.js) + local bare git repos.
                    # No network, no real claude, no subscription usage.

npm run test:e2e    # = E2E=1 node --test test/e2e.test.js
                    # Starts the real service with the project's .env and the REAL claude CLI (uses subscription).
```

E2E knobs (env): `E2E_BRANCHES=main,dev`, `E2E_MARKER_CONTENT=<text>` (T5: push `MARKER.txt` with that content
to `REPO_BRANCH` first), `E2E_T7_EXPECT=<regex>`, `E2E_T8_PROMPT=<prompt that triggers a repo skill/command>`
and `E2E_T8_EXPECT=<regex>` (T8 is skipped unless `E2E_T8_PROMPT` is set), `E2E_JOB_WAIT_SECONDS=1800`.
