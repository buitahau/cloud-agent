# Flow 2 — Client Claude sends a run and receives result / errors

Source: [cloud-test-agent-architecture.md](../cloud-test-agent-architecture.md) §3, §6, §10.
Diagrams use Mermaid (render on GitHub / most Markdown viewers).

## 2a. Normal run (polling)

```mermaid
sequenceDiagram
    autonumber
    participant D as Dev agent (Claude Code)
    participant CLI as cloudtest CLI (background cmd)
    participant GH as GitHub
    participant API as VPS API

    D->>CLI: cloudtest run <project> (background)
    Note over D: keeps working meanwhile
    CLI->>GH: git push -f origin HEAD:agent/test
    CLI->>API: POST /api/runs {project, sha}
    API-->>CLI: 202 {run_id}
    loop every ~5s with backoff
        CLI->>API: GET /api/runs/{id}
        API-->>CLI: status = queued | running
    end
    CLI->>API: GET /api/runs/{id}
    API-->>CLI: status = done + report_md
    CLI-->>D: compact report, exit 0 (pass) / non-zero (fail)
    D->>D: fix failures, repeat
```

## 2b. Error paths

```mermaid
flowchart TD
    P[CLI polls GET /api/runs/id] --> R{Response}
    R -- 401 --> E1[Bad API token: stop, print fix hint, non-zero exit]
    R -- 404 --> E2[Unknown run / project: stop, non-zero exit]
    R -- 5xx --> B[Retry with exponential backoff] --> P
    R -- network drop / laptop sleep --> N[Run keeps going on VPS<br/>CLI resumes polling by run_id] --> P
    R -- status queued/running --> W[Wait ~5s] --> D{Client deadline hit?}
    D -- yes --> E3[Give up locally, run continues server-side, non-zero exit]
    D -- no --> P
    R -- status = error --> E4[Print error e.g. claude login expired, non-zero exit]
    R -- status = timeout --> E5[Print timeout notice + partial report, non-zero exit]
    R -- status = done --> OK[Print report; exit 0 or 1 by RESULT]
```

Exit codes 2–5 for the distinct error classes are a suggestion; the source doc only says "non-zero on fail".

## 2c. Polling vs SSE

SSE is **not** part of the current design (cut in §10). Shown for comparison only.

```mermaid
sequenceDiagram
    participant CLI as cloudtest CLI
    participant API as VPS API

    rect rgb(235,245,255)
    Note over CLI,API: Current: polling
    loop every ~5s
        CLI->>API: GET /api/runs/{id}
        API-->>CLI: status
    end
    end

    rect rgb(255,245,230)
    Note over CLI,API: Optional / future: SSE
    CLI->>API: GET /api/runs/{id}/events
    API-->>CLI: event: status / log ...
    Note over CLI,API: connection drops
    CLI->>API: GET /events (Last-Event-ID: n)
    API-->>CLI: replay missed events
    Note over CLI: if SSE unavailable, fall back to polling
    end
```

## Gaps in the source doc

- Backoff limits and the CLI's overall deadline are not specified.
- Exit code meanings are not defined.
- Response shape of `GET /api/runs/{id}` (report, artifact links) is not defined.
- Where `run_id` is stored so a restarted CLI can resume is not defined.
