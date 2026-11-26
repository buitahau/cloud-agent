# Plan: Repos in SQLite + encrypted per-repo tokens

Status: **proposed**. Produced by an Opus planning pass over the codebase at commit 1b70977. The decisions in §0
were accepted, and they override the rest of this document wherever the two differ. Each PR in §10 updates the
README as it ships.

## 0. Decisions taken

| # | Question | Decision |
|---|---|---|
| 1 | Where repo config lives | **SQLite** (`node:sqlite`), one file in the `data` volume (`DB_FILE`, default `./data/cloud-agent.db`). |
| 2 | Where secrets live | **Encrypted columns in the DB** (AES-256-GCM). The master key is `MASTER_KEY` in `.env`. No external vault. |
| 3 | Token scope | **Each repo has its own GitHub token**, stored encrypted with that repo. No global or fallback token. |
| 4 | How repos are created/edited | **Admin write API + dashboard UI**, plus a **one-time import of `repos.json` + `GIT_TOKEN_*` on first boot**. No CLI that edits repos. |
| 5 | Repo management through the `x-api-key` API | **No.** Admin (Basic auth) only, for now. |
| 6 | `jobs.jsonl` → SQLite | **Later**, separate PR (§10 PR 6). |
| 7 | ssh keys | **Stay files**; the DB stores only `ssh_key_path`, restricted to `SSH_KEYS_DIR`. Encrypted keys in the DB are optional later. |
| 8 | Repo URL moved to another host | **The token must be entered again**, and the workspace is wiped and re-cloned. |
| 9 | Missing/wrong key at startup | **Fail fast** (exit 1, naming the affected repo ids, never the values). |
| 10 | Local / `file://` repos through the API | **Rejected** unless `ALLOW_LOCAL_REPOS=true` (tests set it). |

Constraints: **no new npm dependencies** (`node:sqlite`, `node:crypto` only). `engines` moves from `>=18.20` to
`>=22.13`; Docker and CI already run Node 24.

---

## 1. How it works today

- **Config:** `src/config.js` loads `REPOS_FILE` once at startup. For each repo, `auth.tokenEnv` names an env var
  holding that repo's token (`config.js:276-285`). https repos without one fail startup (`config.js:289`). A bare
  `GIT_TOKEN` is rejected unless a repo names it (`config.js:70,125-130`). **There is no shared or fallback token**,
  so decision 3 is already met; only the storage location changes.
- **Registry:** `src/repoRegistry.js` has one GitSync per repo (`repoRegistry.js:48-54`) and is fixed at startup
  (`repoRegistry.js:3`).
- **Token injection:** `GIT_CONFIG_KEY_0=http.<origin>/.extraHeader` (`src/gitSync.js:173-180`). The token is scoped
  to the repo's own origin and never appears in argv or `.git/config`.
- **Worker:** `src/worker.js:111-114` looks up the repo when a job is picked (an unknown repo fails the job), and
  keeps a snapshot of `gitSync`/`workspaceDir` for the whole run (`worker.js:124`). This is the hook that lets the
  registry become mutable.
- **Admin:** read-only, mounted before `express.json` (`src/server.js:83-85`). `src/admin.js:8-9` already notes
  that writes will need CSRF protection.

### 1.1 Problem found: every claude job sees every secret

`buildClaudeEnv` copies all of `process.env` and only removes the Anthropic variables
(`src/claudeRunner.js:10-16,162-165`). So `GIT_TOKEN_*`, `API_KEY` and `ADMIN_PASSWORD` all reach a `claude` that runs
with bypassed permissions inside an untrusted target repo, and a prompt-injected repo could read and exfiltrate
them. This is fixed first (PR 0), and `MASTER_KEY*` must be added to the strip list too.

### 1.2 What encryption at rest does and doesn't protect

`claude` runs as the same uid as node. It can read `/app/data/*.db` and probably `/proc/<node pid>/environ`, and
deleting a variable from `process.env` doesn't clear the latter. So encryption protects **backups, volume snapshots
and copied DB files**. It does **not** protect against a compromised agent. That would need claude to run under a
separate uid, which is out of scope here and recorded as a known limit.

---

## 2. SQLite

**Library: `node:sqlite` (`DatabaseSync`), not better-sqlite3.**
- Runtime and CI are Node 24 (`Dockerfile:3,12`, `ci-cd.yml`). `node:sqlite` works without a flag from Node 22.13.
- better-sqlite3 is a native addon: on bookworm-slim it either downloads a prebuilt binary or needs
  python3/make/g++ in the image, and it must be rebuilt on every Node major. It would also break the
  no-new-dependencies rule.
- The synchronous API suits the synchronous store and persistence code.
- Costs:
  - `engines` → `>=22.13`, and the README's "Node ≥ 18.20" line changes (web/ already needs 22.22).
  - There's no `db.transaction()` helper, so we add a small `tx(fn)` doing `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.
  - Check whether `node:24-bookworm-slim` prints an `ExperimentalWarning`. If it does, filter that one warning in
    `index.js`.

**Opening the DB** (`src/db.js`):
- `DB_FILE` defaults to `./data/cloud-agent.db`; compose sets `/app/data/cloud-agent.db`.
- `mkdir` the directory with mode 0700, pre-create the file with `fs.openSync(f, 'a', 0o600)`, then open it.
- Pragmas: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.
- chmod the `-wal`/`-shm` files to 0600, matching the jobs file (`jobPersistence.js:59,75`).

**Migrations** (`src/db/migrations.js`):
- `PRAGMA user_version` plus an append-only array of SQL strings.
- Each migration runs in its own transaction, and already-shipped migrations are never edited.
- Startup refuses a DB whose `user_version` is newer than the code, which catches a rollback to an older image.

## 3. Schema (migration 1)

```sql
CREATE TABLE repos (
  id             TEXT PRIMARY KEY,   -- immutable: URL segment, workspace dir name, part of the AAD
  url            TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('https','ssh','local')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  ssh_key_path   TEXT,               -- ssh only
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE repo_secrets (           -- one row per (repo, secret); 'token' now, 'ssh_key' possible later
  repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (name IN ('token')),
  alg        TEXT NOT NULL DEFAULT 'A256GCM',
  key_id     TEXT NOT NULL,
  iv         BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag        BLOB NOT NULL,
  hint       TEXT NOT NULL,           -- last 4 chars, display only
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);
CREATE INDEX repo_secrets_key_id ON repo_secrets(key_id);   -- rotation sweep

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  ip      TEXT,
  action  TEXT NOT NULL,
  repo_id TEXT,
  details TEXT NOT NULL DEFAULT '{}'  -- JSON, never secrets
);
CREATE INDEX audit_log_repo ON audit_log(repo_id, id);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- e.g. imported_from_repos_json_at
```

- Secrets live in their own table rather than as columns on `repos`. That way ssh keys can be added later without
  extra columns, rotation is a single query, and deleting a repo removes its secrets by cascade.
- `workspaceRoot` leaves `repos.json` and becomes env `WORKSPACE_ROOT` (default `./workspaces`). The check that it
  must not contain the service directory (`config.js:226-229`) moves with it. The name can't be `WORKSPACE_DIR`,
  which is a blocked legacy variable (`config.js:70`).

## 4. Encryption (`src/secrets.js`, pure, `node:crypto` only)

- **Master key:** `MASTER_KEY` is base64 that decodes to exactly 32 bytes (`openssl rand -base64 32`), otherwise a
  `ConfigError`. It is also rejected if it equals `API_KEY` or `ADMIN_PASSWORD`. Required whenever the DB is used.
- **Key ring:** `MASTER_KEY_PREVIOUS` holds older keys, comma-separated, used only to decrypt. The key id is derived,
  never typed by the operator: `kid = HMAC-SHA256(key, "cloud-agent/kid").hex.slice(0,16)`.
- **Subkey:** the data key is `hkdfSync('sha256', master, '', 'cloud-agent/repo-secrets/v1', 32)`, so the master key
  is never used directly.
- **Algorithm:** AES-256-GCM with a fresh 12-byte random IV on every encryption (including re-encryption) and a
  16-byte tag. `alg` and `key_id` are stored per row.
- **AAD:** `cloud-agent|v1|repo_secrets|<repo_id>|<name>|<origin>`, where `<origin>` is `new URL(url).origin`.
  - A ciphertext can't be copied to another repo or secret name.
  - Someone who can write to the DB but doesn't have the key can't point a repo at their own host and have it
    receive the token, because decryption fails.
  - This extends today's rule that the token only goes to the repo's own host (`gitSync.js:173-180`) to tampering
    with the DB.
- **Startup check:** decrypt every row once and keep nothing.
  - Rows exist but no key: exit 1.
  - Unknown `key_id`, or tag failure: exit 1 with `repo "web": token cannot be decrypted with
    MASTER_KEY/MASTER_KEY_PREVIOUS`.
- **Rotation:**
  1. Back up the DB.
  2. Put the new key in `MASTER_KEY` and the old one in `MASTER_KEY_PREVIOUS`.
  3. Run `docker compose up -d`.
  4. At startup, one transaction re-encrypts every row whose `key_id` isn't the current one and logs
     `Re-encrypted N secret(s) to key <kid>`; one `key.rotate` audit row is written.
  5. Remove `MASTER_KEY_PREVIOUS`.
  - While `MASTER_KEY_PREVIOUS` is set but no rows use it, startup logs a warning.
- **Plaintext never leaves the process:**
  - `RepoConfig` loses `token`/`tokenEnv` (`config.js:34-35`).
  - API and dashboard show only `token: { set, hint: "…a1b2", updated_at }`.
  - `redactConfig` (`config.js:336`) masks the master keys.
  - `MASTER_KEY*`, `API_KEY`, `ADMIN_PASSWORD` and any legacy `GIT_TOKEN_*` are stripped from claude's env and git's
    env.
  - `buildGitEnv` forces `GIT_TRACE_REDACT=1` (`gitSync.js:167`), so an operator's `GIT_TRACE_CURL` can't write the
    Authorization header into job logs.
  - Token input: 1–1000 chars, no whitespace or control characters. Error messages never include the value.

## 5. Runtime changes

- **Decrypt at sync time:**
  - `createGitSync` takes `getToken: () => string | null` instead of `token`.
  - `sync()` calls it right before `buildGitEnv`. A decryption failure becomes
    `GitSyncError('validate', 'token cannot be decrypted')`.
  - A token change therefore applies on the next sync without a restart, and the plaintext only ever sits in that
    run's child env object.
- **Mutable registry** (`src/repoRegistry.js`):
  - `createRepoRegistry({ repoStore, gitTimeoutMs, workspaceRoot })` loads from the DB and exposes
    `create / update / setToken / setEnabled / remove` alongside `get / has / list / ids / status`.
  - Each mutation writes the DB row and its audit row in one transaction, then swaps the in-memory entry.
  - A running job keeps its snapshot (`worker.js:124`); a queued job uses the current entry when it starts
    (`worker.js:111`).
- **Disable:** `enabled = false` makes `POST /<repo>/run-agent` return `409 {error: 'repo disabled'}`. The worker
  fails that repo's queued jobs with "repo disabled" (new check next to `worker.js:112`). A running job finishes.
- **Delete:**
  - Refused with `409` if the repo has queued or running jobs ("disable it and wait").
  - Otherwise the row, its secrets and the workspace dir are removed, and job history stays.
  - `GET /<id>/run-agent/:job` then returns 404, but the admin `/jobs?repo=` filter (`admin.js:90`) accepts any valid
    id so the history stays filterable.
- **URL change:**
  - Refused with `409` while a job is running.
  - If `normalizeRemote` says it's the same remote, the GitSync is rebuilt and nothing else changes.
  - Otherwise the GitSync is rebuilt and `<workspaceDir>` is deleted. Without that, the next sync fails with the
    "clone of a different repo" check (`gitSync.js:123`).
  - Switching https to ssh changes which credential is required. A host change drops the token (decision 8).
- **Validation:**
  - The per-repo checks in `loadReposFile` (`config.js:236-309`) move into a pure
    `validateRepoInput(input, { allowLocal, sshKeysDir })` in `src/lib/repoValidate.js`.
  - The DB loader, the importer and the admin API all use it.
  - Repo URLs are now user input, so only `https://`, `ssh://`/scp-style and (when allowed) local paths are
    accepted. Every other transport (`ext::`, `fd::`, etc.) stays rejected.
- **`config.js`:**
  - `REPOS_FILE` is no longer required.
  - Adds `DB_FILE`, `MASTER_KEY`, `MASTER_KEY_PREVIOUS`, `WORKSPACE_ROOT`, `ALLOW_LOCAL_REPOS`, `SSH_KEYS_DIR`
    (default `/run/ssh-keys`).
  - `loadReposFile` stays only for the importer.
  - Zero repos is allowed (a warning, not an error), so a fresh install can be set up from the UI.
- **Startup order (`index.js`):** config → open DB, migrate, verify key, rotate, first-boot import → Claude auth
  probe. Key errors then fail before a probe is spent. The DB is closed on shutdown.

## 6. Admin API and dashboard

New routes under `/admin/api`, which gets its own `express.json({ limit: '64kb' })`:

| Method | Path | Body / notes |
|---|---|---|
| POST | `/repos` | `{id, url, defaultBranch?, sshKeyPath?, token?}` → 201. https requires `token`. |
| PATCH | `/repos/:id` | `{url?, defaultBranch?, sshKeyPath?, enabled?}`. Rules from §5. |
| PUT | `/repos/:id/token` | `{token}` → 204. Write-only, never echoed back. |
| DELETE | `/repos/:id` | 204, or 409 |
| GET | `/audit?repo=&limit=&before=` | read-only list |

`status()` (`repoRegistry.js:110`) adds `enabled` and
`auth: { kind, token: { set, hint, updated_at } | null, ssh_key_path }`.

**CSRF.** Browsers attach Basic credentials automatically, so every non-GET request must meet all of these, or it
gets 403:
- `Content-Type: application/json`;
- a custom `X-Admin-Request: 1` header, which forces a CORS preflight that the app never approves;
- `Origin`, when present, equals the request host (`X-Forwarded-Proto/Host` is trusted only with `TRUST_PROXY`);
- `Sec-Fetch-Site` is absent or `same-origin`.

`web/src/api/client.ts` gets a `sendJson()` that sets the header.

**Auth.** `ADMIN_PASSWORD` is now a write credential. The rule stays ≥ 8 chars and ≠ `API_KEY`
(`config.js:151-154`), and the README recommends ≥ 16. Without `ADMIN_PASSWORD`, repos can only come from the
first-boot import. The CSP `form-action 'none'` stays.

**Audit.**
- Every mutation writes one row:
  - `actor`: the admin user;
  - `ip`;
  - `action`: one of `repo.create`, `repo.update`, `repo.enable`, `repo.disable`, `repo.delete`, `token.set`,
    `key.rotate`, `import`;
  - `repo_id`;
  - `details`: changed field names, old and new values for non-secret fields, and `"token": "set …a1b2"` for
    tokens.
- The row is written in the same transaction as the change, and a matching line is printed to the console.

**Dashboard:**
- Overview: an "Add repo" button.
- Repo page:
  - an edit form (URL, branch, enabled);
  - a "Set token" modal using `Input.Password`, cleared after submit;
  - an enable toggle;
  - a delete confirmation;
  - an Audit tab.

## 7. Migration from `repos.json` + `GIT_TOKEN_*`

**Import on first boot** (`src/repoImport.js`):
- Runs only if:
  - the `repos` table is empty;
  - `meta.imported_from_repos_json_at` is unset;
  - `REPOS_FILE` (default `./repos.json`) is readable.
- Parses with `loadReposFile`, resolves each `tokenEnv` from the env, validates, encrypts, and inserts everything in
  one transaction plus a `meta` row and an `import` audit row.
- Logs `Imported N repos from repos.json; you can now remove REPOS_FILE, the repos.json mount and GIT_TOKEN_* from
  .env`.
- A missing token variable or any invalid repo aborts with the same problem list as today. Nothing is half-imported.
- Once the DB has rows, `REPOS_FILE` and `GIT_TOKEN_*` are ignored with a warning. They still leak into claude's env
  if left in `.env`; PR 0 strips the ones it knows about.

## 8. Deploy

CI deploys automatically on merge and overwrites the VPS compose file.

1. **Before merging PR 2:** add `MASTER_KEY` to `/opt/cloud-agent/.env`. Without it, the new image's import fails and
   the container keeps restarting.
2. **Release N (PR 2):** compose adds `DB_FILE: /app/data/cloud-agent.db`. It **keeps** the
   `./repos.json:/app/repos.json:ro` mount and `REPOS_FILE`, so the import works on the VPS.
3. **After the import is confirmed in the logs:** remove `GIT_TOKEN_*` from `.env`, then run `docker compose up -d`.
4. **Release N+1 (PR 5):** remove the `repos.json` mount. If the host file is missing, Docker creates a *directory*
   at that path, so the mount shouldn't outlive its use. A leftover `REPOS_FILE` or `GIT_TOKEN_*` becomes a startup
   error.

Other deploy points:
- **Permissions:** the `data` volume is already owned by uid 1000 (`Dockerfile`), and the DB and WAL files are 0600.
- **Backups:**
  - Back up with `docker compose exec cloud-agent node src/cli.js backup /app/data/backups/<ts>.db`, which runs
    `VACUUM INTO`.
  - A plain `cp` of a WAL database while it's running can lose recent writes.
  - Keep `MASTER_KEY` **separate** from backups, for example in a password manager. A backup is useless without the
    key, and dangerous stored next to it.

## 9. Testing (node:test, no new dependencies, temp dirs, fake claude, local bare repos)

- **`test/secrets.test.js`:**
  - round trip;
  - encrypting the same value twice gives a different IV and ciphertext;
  - flipping any byte of iv, ciphertext or tag fails;
  - a ciphertext moved to another repo id, secret name or origin fails;
  - the wrong key fails;
  - a key ring with a previous key decrypts;
  - key format errors (31 or 33 bytes, not base64, equal to `API_KEY`);
  - error messages never contain the plaintext.
- **`test/db.test.js`:**
  - migrating a fresh file from 0 to N is idempotent and sets `user_version`;
  - a newer `user_version` is refused;
  - file modes are 0600 (skipped on win32).
- **`test/repoStore.test.js`:**
  - CRUD through `validateRepoInput`, including today's `config.test.js` repo cases (ported);
  - `list()` and `status()` JSON never contain the token;
  - cascade delete;
  - rotation re-encrypts only rows on the old key.
- **`test/repoImport.test.js`:**
  - imports `repos.json` + env;
  - runs only once;
  - aborts atomically on a missing env var;
  - is ignored when the DB already has rows.
- **Registry and worker (git fixture):**
  - a token set after creation is used by the next sync;
  - an update during a running job leaves that job's snapshot alone;
  - disabling a repo fails its queued jobs;
  - deleting a repo with jobs returns 409;
  - a URL change to a different remote wipes the workspace and re-clones.
- **`test/gitSync.test.js`:** the `getToken` callback; `GIT_TRACE_REDACT=1`.
- **`test/claudeRunner.test.js`:** `MASTER_KEY*`, `API_KEY`, `ADMIN_PASSWORD` and `GIT_TOKEN_*` are stripped.
- **`test/server.test.js` (admin):**
  - write routes need Basic auth;
  - 403 when `X-Admin-Request` is missing, `Origin` is foreign, `Sec-Fetch-Site: cross-site` is sent, or the content
    type isn't JSON;
  - `PUT /token` returns 204 with an empty body;
  - an audit row is written.
- **`test/startup.test.js`:**
  - an empty DB starts with 0 repos;
  - first-boot import works;
  - a missing key exits 1;
  - a wrong key exits 1 naming the repo;
  - a token never appears in stdout or stderr;
  - `cleanEnv` also strips `MASTER_KEY|DB_FILE|WORKSPACE_ROOT`.
- **`npm run test:web`** (tsc) covers the UI. **`e2e.test.js`** imports `repos.json` into a temp DB.

## 10. Implementation order (each PR keeps `npm test` green)

| PR | Content | Files | Risk |
|---|---|---|---|
| **0. Stop passing secrets to claude** | Strip `API_KEY`, `ADMIN_PASSWORD`, every repo's `tokenEnv` and `MASTER_KEY*` from claude's env; force `GIT_TRACE_REDACT` | M `src/claudeRunner.js`, `src/claudeAuth.js`, `src/index.js`, `src/gitSync.js`, tests | Low |
| **1. DB + crypto foundations** (not wired in yet) | `node:sqlite` wrapper, migrations, key ring, AES-GCM, `engines >=22.13` | C `src/db.js`, `src/db/migrations.js`, `src/secrets.js`, `test/db.test.js`, `test/secrets.test.js`; M `package.json` | ExperimentalWarning on Node 24 (verify) |
| **2. Repos come from SQLite** (read-only at runtime) | Extract `repoValidate`; add `repoStore`, first-boot import, key check + rotation at startup, `getToken`, config/env changes, compose/README/.env.example updates, `cli.js backup` | C `src/lib/repoValidate.js`, `src/repoStore.js`, `src/repoImport.js`, `src/cli.js`, tests; M `src/config.js`, `src/repoRegistry.js`, `src/gitSync.js`, `src/index.js`, `docker-compose.yml`, `.env.example`, `README.md`, `test/config.test.js`, `test/startup.test.js`, `test/e2e.test.js` | Deploy order (`MASTER_KEY` first); a failed import causes a restart loop. Keep the compose mount. |
| **3. Mutable registry + admin write API + CSRF + audit** | §5 and §6, server side | M `src/repoRegistry.js`, `src/worker.js`, `src/server.js`, `src/admin.js`; C `src/lib/csrf.js`; tests | Races between workspace wipe and a running job (guarded by the 409 rules) |
| **4. Dashboard repo management** | Add/edit form, token modal, enable toggle, delete confirmation, audit tab | M `web/src/api/{client,queries,types}.ts`, `web/src/pages/{RepoPage,OverviewPage}.tsx`, `web/src/components/RepoCard.tsx`; C `web/src/components/RepoForm.tsx`, `TokenModal.tsx` | Low |
| **5. Cleanup (release N+1)** | Remove the `repos.json` mount; leftover `REPOS_FILE` / `GIT_TOKEN_*` become startup errors | M `docker-compose.yml`, `src/config.js`, `README.md` | Operators who skipped step 3 of §8 |
| **6. Optional** | `jobs` table replacing JSONL; ssh keys encrypted in the DB (written to a 0600 temp file during sync) | `src/jobPersistence.js` → `src/jobDb.js`, migration 2 | Separate decision (§0 decisions 6 and 7) |

## 11. Known limits

- A compromised `claude` process can read the DB and the service's environment, because it runs as the same uid
  (§1.2). Fully isolating secrets from the agent needs claude to run under a separate uid or in a separate
  container.
- Basic auth with a single shared admin password: there are no per-user accounts. The audit `actor` is always
  `ADMIN_USER`.
- Losing `MASTER_KEY` means every token has to be entered again. Back up the key separately from the DB.
