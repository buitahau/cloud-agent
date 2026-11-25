# Sequence diagrams

Diagrams use [Mermaid](https://mermaid.js.org/) (rendered natively by GitHub and most Markdown viewers).
Overview: [../ARCHITECTURE.md](../ARCHITECTURE.md).

## 1. Submit a job and run it

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant S as server.js
    participant ST as jobStore
    participant W as worker
    participant G as gitSync
    participant R as claudeRunner
    participant CLI as claude CLI
    participant O as Origin repo

    C->>S: POST /run-agent {prompt, branch?} (x-api-key)
    S->>S: apiKeyAuth + validate body
    S->>ST: create(prompt, branch)
    ST-->>S: job (queued)
    S->>W: enqueue(job.id)
    S-->>C: 202 {id, status: "queued"}

    Note over W: setImmediate -> drain(), one job at a time
    W->>ST: transition(id, pulling)
    W->>G: sync(branch, log, signal)
    G->>O: git clone (first run) / fetch origin/branch
    G->>G: checkout, reset --hard, clean
    G-->>W: {commit}
    W->>ST: update(id, {commit})

    W->>ST: transition(id, running)
    W->>R: run({prompt, cwd, log, onEvent, signal})
    R->>CLI: spawn claude -p --output-format stream-json --verbose (prompt on stdin)
    loop each stdout line (NDJSON)
        CLI-->>R: init / assistant / user / result line
        R->>R: toEvents(line)
        R->>W: onEvent(type, data)
        W->>ST: appendEvent(id, type, data)
    end
    CLI-->>R: exit code + final result line
    R-->>W: {outcome, result, error, meta}
    W->>ST: transition(id, outcome, {result, error, claude})
    Note over ST: emits status event, then terminal result event
```

## 2. Poll for status

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant S as server.js
    participant ST as jobStore

    loop until status is succeeded | failed | timeout
        C->>S: GET /run-agent/:id (x-api-key)
        S->>ST: get(id)
        alt unknown id
            ST-->>S: undefined
            S-->>C: 404 {error: "job not found"}
        else found
            ST-->>S: job
            S-->>C: 200 {status, commit, result, error, logs_tail, claude}
        end
    end
```

## 3. Live progress over SSE

```mermaid
sequenceDiagram
    autonumber
    actor C as Client (fetch + stream reader)
    participant S as server.js (SSE handler)
    participant ST as jobStore
    participant W as worker

    C->>S: GET /run-agent/:id/events (x-api-key, Last-Event-ID?)
    S->>ST: get(id)
    alt unknown id
        S-->>C: 404 {error: "job not found"}
    else found
        S-->>C: 200 text/event-stream, "retry: 3000"
        S->>ST: subscribe(id, send)
        S->>ST: readEvents(id, lastEventId)
        ST-->>S: {events, dropped}
        opt dropped > 0
            S-->>C: event: gap {dropped}
        end
        loop buffered events
            S-->>C: id / event / data frame
        end

        alt job already terminal
            S-->>C: (result event replayed) close stream
        else job still running
            loop until terminal result event
                W->>ST: appendEvent / appendLog / transition
                ST-->>S: subscriber callback(evt)
                S-->>C: id: seq, event: type, data: json
                opt every 15 s of silence
                    S-->>C: ": ping" (comment)
                end
            end
            ST-->>S: result event (terminal)
            S-->>C: event: result {status, result, error, claude}
            S->>ST: unsubscribe
            S-->>C: end response
        end
    end
```

## 4. Reconnect and resume

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant S as server.js
    participant ST as jobStore

    C->>S: GET /events
    S-->>C: id 1 ... id 7
    Note over C,S: connection drops (network, proxy, slow-reader drop)
    C->>S: GET /events (Last-Event-ID: 7) or ?since=7
    S->>ST: subscribe + readEvents(id, 7)
    ST-->>S: events with seq > 7
    S-->>C: id 8 ... live events continue
```

## 5. Timeout and graceful shutdown

```mermaid
sequenceDiagram
    autonumber
    participant W as worker
    participant R as claudeRunner
    participant P as processRunner
    participant CLI as claude (own process group)
    participant ST as jobStore
    participant S as server.js
    actor C as SSE client

    alt JOB_TIMEOUT_SECONDS exceeded
        P->>CLI: SIGTERM to process group
        P->>CLI: SIGKILL after grace period
        P-->>R: {timedOut: true}
        R-->>W: {outcome: "timeout"}
        W->>ST: transition(id, timeout)
        ST-->>S: result event
        S-->>C: event: result, stream closes
    else SIGINT / SIGTERM on the service
        W->>W: shutdown(): fail queued jobs, abort running job
        W->>P: abort signal
        P->>CLI: SIGTERM, then SIGKILL (process group)
        W->>ST: transition(id, failed "Service shutting down")
        ST-->>S: result event
        S->>S: closeStreams() ends remaining SSE responses
        S->>S: process exit
    end
```
