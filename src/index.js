// src/index.js
// Entry point: load .env -> validate config -> database (repos) -> Claude auth check (T1) -> wire modules -> listen.
// Exit code 1 with a clear message on any startup failure.

import 'dotenv/config'; // populates process.env from ./.env (does not override already-set vars)
import { loadConfig, redactConfig, ConfigError } from './config.js';
import { openDb, closeDb } from './db.js';
import { migrate } from './db/migrations.js';
import { createRepoStore, verifyAndRotateSecrets, checkStoredRepos, findEnvVarsHoldingTokens } from './repoStore.js';
import { checkClaudeAuth, ClaudeAuthError } from './claudeAuth.js';
import { createJobStore } from './jobStore.js';
import { createRepoRegistry } from './repoRegistry.js';
import { createJobPersistence } from './jobPersistence.js';
import { createAdminRouter } from './admin.js';
import { createClaudeRunner } from './claudeRunner.js';
import { createWorker } from './worker.js';
import { createApp, startServer } from './server.js';

/**
 * Startup sequence (exact log lines in quotes are part of the contract — T1 greps for "Claude auth OK"):
 *
 *  1. config = loadConfig(process.env)
 *       ConfigError -> console.error(err.message); process.exit(1)
 *       REPOS_FILE / GIT_TOKEN / GIT_TOKEN_* (and the single-repo vars) set -> ConfigError (no longer read; nothing
 *         to import at startup: node src/cli.js import fills an empty DB)
 *     console.log('Config:', JSON.stringify(redactConfig(config)))
 *  2. if process.getuid?.() === 0 && config.claudePermissionMode === 'bypassPermissions':
 *       console.warn — claude refuses bypassPermissions as root; run as a non-root user.
 *  3. database, all BEFORE the Claude probe (any failure -> console.error(message); process.exit(1)):
 *       db = openDb(DB_FILE); migrate(db); repoStore = createRepoStore(...)
 *       verifyAndRotateSecrets: every stored token must decrypt with MASTER_KEY / MASTER_KEY_PREVIOUS; tokens
 *         on a previous key are re-encrypted to MASTER_KEY ("Re-encrypted N secret(s) to key <kid>")
 *       checkStoredRepos: invalid rows are fatal; missing ssh key / missing https token only warn
 *     console.log(`Database: <file> (schema vN[, migrated from vM], key <kid>)`)
 *       tokenVars = findEnvVarsHoldingTokens(repoStore, process.env): env vars holding a stored token -> one WARNING each
 *     secretEnvNames = their names (hidden from claude and git; GIT_TOKEN* are always stripped)
 *  4. auth = await checkClaudeAuth({ claudeBin, probe: config.claudeAuthProbe, secretEnvNames })
 *       ClaudeAuthError -> console.error(err.message); process.exit(1)
 *     console.log(`Claude auth OK (${auth.authMethod}, ${auth.version}${auth.probed ? ', probe passed' : ', probe skipped'})`)
 *  5. persistence = JOBS_FILE ? createJobPersistence(...) : null
 *     store  = createJobStore({ logsTailLines, retentionMax: jobRetentionMax, onPersist: persistence?.append })
 *     if persistence: store.hydrate(persistence.load()); persistence.compact(...)
 *       console.log(`Jobs file: <file> (<n> jobs loaded, <m> interrupted)`)
 *     repos  = createRepoRegistry({ repoStore, jobs: store, workspaceRoot, gitTimeoutMs, secretEnvNames, allowLocal, sshKeysDir })
 *              (one GitSync per stored repo; mutable at runtime through the admin API, which needs the job store to
 *              refuse changes while jobs are active and the validation rules for new/edited repos)
 *     runner = createClaudeRunner({ claudeBin, permissionMode, maxTurns, timeoutMs: jobTimeoutMs, secretEnvNames })   (shared)
 *     worker = createWorker({ store, repos, claudeRunner: runner, maxConcurrent: maxConcurrentJobs })
 *     app    = createApp({ config, store, worker, repos, adminRouter? })   (admin only if ADMIN_PASSWORD is set)
 *     console.log(`Repos: <id>, <id>` or `Repos: (none)`) and `Admin dashboard: /admin/` or `Admin dashboard: disabled ...`
 *  6. server = await startServer(app, config.port)
 *     console.log(`Listening on :${server.address().port}`)
 *  7. SIGINT/SIGTERM (once): console.log('Shutting down'); server.close(); await worker.shutdown();
 *     closeDb(db); process.exit(0). Needed because claude runs in its own process group (detached) and would
 *     otherwise outlive us.
 *  8. process.on('unhandledRejection') -> console.error, do NOT exit (service must stay up, T9).
 *
 * Workspaces are NOT cloned at startup; a repo's first job clones it (keeps startup fast, and a bad
 * repo URL shows up as a failed job per T9 instead of a crash).
 *
 * @returns {Promise<void>}
 */
export async function main() {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (service keeps running):', reason);
  });

  // 1. config
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  console.log('Config:', JSON.stringify(redactConfig(config)));

  // 2. root warning
  if (process.getuid?.() === 0 && config.claudePermissionMode === 'bypassPermissions') {
    console.warn('WARNING: running as root — claude refuses --permission-mode bypassPermissions as root; run as a non-root user.');
  }

  // 3. database: open, migrate, verify + rotate secrets, check stored repos, find env vars holding tokens (all before the Claude probe)
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  /** @type {import('node:sqlite').DatabaseSync|undefined} */
  let db;
  /** @type {import('./repoStore.js').RepoStore} */
  let repoStore;
  /** @type {{ name: string, repoId: string }[]} */
  let tokenVars = [];
  try {
    db = openDb(config.dbFile);
    const { from, to } = migrate(db);
    repoStore = createRepoStore({ db, keyRing: config.keyRing });
    verifyAndRotateSecrets({ store: repoStore, keyRing: config.keyRing, log });
    const checked = checkStoredRepos(repoStore, { allowLocal: config.allowLocalRepos, sshKeysDir: config.sshKeysDir });
    for (const w of checked.warnings) console.warn(`WARNING: ${w}`);
    if (checked.problems.length) throw new Error(`Invalid repos in ${config.dbFile}:\n  - ${checked.problems.join('\n  - ')}`);
    tokenVars = findEnvVarsHoldingTokens(repoStore, process.env);
    console.log(`Database: ${config.dbFile} (schema v${to}${from === to ? '' : `, migrated from v${from}`}, key ${config.keyRing.currentKeyId})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err)); // messages never contain secret values
    if (db) closeDb(db);
    process.exit(1);
  }
  for (const v of tokenVars) {
    console.warn(`WARNING: ${v.name} holds the token of repo "${v.repoId}", which is stored encrypted in the database; it is hidden from claude and git, but remove it from .env`);
  }
  // Env vars holding a stored token (any name); GIT_TOKEN / GIT_TOKEN_* cannot get here (ConfigError) and are stripped anyway.
  const secretEnvNames = tokenVars.map((v) => v.name);

  // 4. auth (T1)
  let auth;
  try {
    auth = await checkClaudeAuth({
      claudeBin: config.claudeBin,
      probe: config.claudeAuthProbe,
      secretEnvNames,
    });
  } catch (err) {
    if (err instanceof ClaudeAuthError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Claude auth OK (${auth.authMethod}, ${auth.version}${auth.probed ? ', probe passed' : ', probe skipped'})`);

  // 5. wiring
  /** @type {ReturnType<typeof createJobPersistence>|null} */
  let persistence = null;
  /** @type {ReturnType<typeof createJobStore>} */
  let store;
  if (config.jobsFile) {
    persistence = createJobPersistence({
      file: config.jobsFile,
      getSnapshots: () => store.list().map((j) => store.snapshot(j)),
      compactAfterLines: Math.max(2000, config.jobRetentionMax * 2),
    });
  }
  store = createJobStore({
    logsTailLines: config.logsTailLines,
    retentionMax: config.jobRetentionMax,
    onPersist: persistence ? (snap) => persistence.append(snap) : undefined,
  });
  if (persistence) {
    const { loaded, interrupted } = store.hydrate(persistence.load());
    persistence.compact(store.list().map((j) => store.snapshot(j)));
    console.log(`Jobs file: ${config.jobsFile} (${loaded} jobs loaded, ${interrupted} interrupted)`);
  }
  const repos = createRepoRegistry({
    repoStore,
    jobs: store,
    workspaceRoot: config.workspaceRoot,
    gitTimeoutMs: config.gitTimeoutMs,
    secretEnvNames,
    allowLocal: config.allowLocalRepos,
    sshKeysDir: config.sshKeysDir,
  });
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    permissionMode: config.claudePermissionMode,
    maxTurns: config.claudeMaxTurns,
    timeoutMs: config.jobTimeoutMs,
    secretEnvNames,
  });
  const worker = createWorker({ store, repos, claudeRunner: runner, maxConcurrent: config.maxConcurrentJobs });
  const adminRouter = config.adminPassword
    ? createAdminRouter({
      config: { adminUser: config.adminUser, adminPassword: config.adminPassword, trustProxy: config.trustProxy },
      store,
      worker,
      repos,
      persistence: Boolean(persistence),
    })
    : undefined;
  const app = createApp({ config, store, worker, repos, adminRouter });
  const ids = repos.ids();
  if (ids.length === 0) {
    console.warn(`WARNING: no repos configured (empty database); add one in the admin dashboard, with POST /admin/api/repos${adminRouter ? '' : ' (set ADMIN_PASSWORD to enable them)'}, or import a repos.json with: node src/cli.js import <file> (then restart)`);
  }
  console.log(`Repos: ${ids.length ? ids.join(', ') : '(none)'} (max ${config.maxConcurrentJobs} concurrent job${config.maxConcurrentJobs === 1 ? '' : 's'})`);
  console.log(adminRouter ? 'Admin dashboard: /admin/' : 'Admin dashboard: disabled (set ADMIN_PASSWORD to enable)');

  // 6. listen
  const server = await startServer(app, config.port);

  // 7. graceful shutdown (claude runs in its own process group and would otherwise outlive us)
  let shuttingDown = false;
  const onSignal = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down');
    server.close();
    try {
      await worker.shutdown(`Service shutting down (${sig})`);
      await app.closeStreams(); // terminal events were just emitted; flush them and end SSE connections
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
    try {
      closeDb(/** @type {import('node:sqlite').DatabaseSync} */ (db));
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.once('SIGINT', () => { void onSignal('SIGINT'); });
  process.once('SIGTERM', () => { void onSignal('SIGTERM'); });
  // Announce only once the handlers exist: before that, a SIGTERM gets the OS default action (immediate kill).
  console.log(`Listening on :${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
