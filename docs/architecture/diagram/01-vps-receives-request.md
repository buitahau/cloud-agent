# Flow 1 — VPS receives a request

Source: [cloud-test-agent-architecture.md](../cloud-test-agent-architecture.md) §3, §6, §7, §8.
Diagrams use Mermaid (render on GitHub / most Markdown viewers).

## 1a. API request: `POST /api/runs`

```mermaid
flowchart TD
    A([POST /api/runs  project, sha]) --> B{Static API token valid?}
    B -- no --> E1[401 Unauthorized]
    B -- yes --> C{Project exists?}
    C -- no --> E2[404 Project not found]
    C -- yes --> D{sha / branch valid?}
    D -- no --> E3[422 Invalid sha]
    D -- yes --> F[(SQLite: INSERT runs<br/>status = queued)]
    F --> G([202 Accepted  run_id])
```

## 1b. Worker: from queued row to final status

```mermaid
sequenceDiagram
    autonumber
    participant DB as SQLite (runs)
    participant W as Worker
    participant GH as GitHub
    participant C as claude -p (headless)
    participant P as Playwright
    participant Dev as Dev environment

    W->>DB: claim oldest queued row
    W->>W: take lock (one run at a time)
    W->>DB: status = running, started_at
    W->>GH: git fetch via GIT_ASKPASS (decrypted token)
    GH-->>W: objects for sha
    W->>W: clean worktree at sha
    W->>W: inject env secrets (E2E_BASE_URL...), unset ANTHROPIC_API_KEY
    W->>C: timeout + claude -p (read-only allowedTools, --max-turns)
    C->>P: bash scripts/e2e-ci.sh (pytest + Playwright)
    P->>Dev: browser E2E requests
    Dev-->>P: responses
    P-->>C: results, failures, screenshots
    C-->>W: report.md
    W->>DB: save report + artifacts
    W->>DB: status = done / error / timeout, finished_at
    W->>W: release lock, remove worktree
```

### Failure points

| Failure | Where it appears | Resulting status |
|---|---|---|
| Git fetch fails (bad token, missing sha) | step 4 | `error` |
| Claude login expired | `claude -p` start | `error: claude login expired` |
| Run exceeds `timeout_min` | `claude -p` | `timeout` |
| `--max-turns` reached | `claude -p` | undefined in doc (see gaps) |
| Dev unreachable | Playwright | undefined in doc (see gaps) |
| Worker crash | any step after claim | stuck in `running` (no recovery in doc) |

## 1c. Run state machine

```mermaid
stateDiagram-v2
    [*] --> queued: POST accepted (202)
    queued --> running: worker takes lock
    running --> done: report saved
    running --> error: fetch fail / login expired / crash handled
    running --> timeout: exceeded timeout_min
    done --> [*]
    error --> [*]
    timeout --> [*]
```

Rejected requests (401 / 404 / 422) never create a row.

## Gaps in the source doc

- `POST /api/runs` validation and error codes are not defined; a retried POST can queue the same SHA twice.
- If the worker fetches by branch, a later force-push of `agent/test` can make an older queued SHA unfetchable.
- Unclear whether "dev unreachable" or `--max-turns` ends as `done` (FAIL report) or `error`.
- No recovery for runs stuck in `running` after a worker crash; no cancel.
