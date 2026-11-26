// src/index.js
// Entry point: load .env -> validate config -> Claude auth check (T1) -> wire modules -> listen.
// Exit code 1 with a clear message on any startup failure.

import 'dotenv/config'; // populates process.env from ./.env (does not override already-set vars)
import { loadConfig, redactConfig, ConfigError } from './config.js';
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
 *     console.log('Config:', JSON.stringify(redactConfig(config)))
 *  2. if process.getuid?.() === 0 && config.claudePermissionMode === 'bypassPermissions':
 *       console.warn — claude refuses bypassPermissions as root; run as a non-root user.
 *     secretEnvNames = config.repos' tokenEnv names (hidden from claude and git; process.env is not modified)
 *  3. auth = await checkClaudeAuth({ claudeBin, probe: config.claudeAuthProbe, secretEnvNames })
 *       ClaudeAuthError -> console.error(err.message); process.exit(1)
 *     console.log(`Claude auth OK (${auth.authMethod}, ${auth.version}${auth.probed ? ', probe passed' : ', probe skipped'})`)
 *  4. persistence = JOBS_FILE ? createJobPersistence(...) : null
 *     store  = createJobStore({ logsTailLines, retentionMax: jobRetentionMax, onPersist: persistence?.append })
 *     if persistence: store.hydrate(persistence.load()); persistence.compact(...)
 *       console.log(`Jobs file: <file> (<n> jobs loaded, <m> interrupted)`)
 *     repos  = createRepoRegistry(config.repos, { gitTimeoutMs, secretEnvNames })   (one GitSync per repo)
 *     runner = createClaudeRunner({ claudeBin, permissionMode, maxTurns, timeoutMs: jobTimeoutMs, secretEnvNames })   (shared)
 *     worker = createWorker({ store, repos, claudeRunner: runner, maxConcurrent: maxConcurrentJobs })
 *     app    = createApp({ config, store, worker, repos, adminRouter? })   (admin only if ADMIN_PASSWORD is set)
 *     console.log(`Repos: <id>, <id>`) and `Admin dashboard: /admin/` or `Admin dashboard: disabled ...`
 *  5. server = await startServer(app, config.port)
 *     console.log(`Listening on :${server.address().port}`)
 *  6. SIGINT/SIGTERM (once): console.log('Shutting down'); server.close(); await worker.shutdown();
 *     process.exit(0). Needed because claude runs in its own process group (detached) and would otherwise
 *     outlive us.
 *  7. process.on('unhandledRejection') -> console.error, do NOT exit (service must stay up, T9).
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
  // Repo tokens are read by config; no child process (claude, git) needs the raw variables.
  const secretEnvNames = config.repos.map((r) => r.tokenEnv).filter(Boolean);

  // 2. root warning
  if (process.getuid?.() === 0 && config.claudePermissionMode === 'bypassPermissions') {
    console.warn('WARNING: running as root — claude refuses --permission-mode bypassPermissions as root; run as a non-root user.');
  }

  // 3. auth (T1)
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

  // 4. wiring
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
  const repos = createRepoRegistry(config.repos, { gitTimeoutMs: config.gitTimeoutMs, secretEnvNames });
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
      config: { adminUser: config.adminUser, adminPassword: config.adminPassword },
      store,
      worker,
      repos,
      persistence: Boolean(persistence),
    })
    : undefined;
  const app = createApp({ config, store, worker, repos, adminRouter });
  console.log(`Repos: ${repos.ids().join(', ')} (max ${config.maxConcurrentJobs} concurrent job${config.maxConcurrentJobs === 1 ? '' : 's'})`);
  console.log(adminRouter ? 'Admin dashboard: /admin/' : 'Admin dashboard: disabled (set ADMIN_PASSWORD to enable)');

  // 5. listen
  const server = await startServer(app, config.port);
  console.log(`Listening on :${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`);

  // 6. graceful shutdown (claude runs in its own process group and would otherwise outlive us)
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
    process.exit(0);
  };
  process.once('SIGINT', () => { void onSignal('SIGINT'); });
  process.once('SIGTERM', () => { void onSignal('SIGTERM'); });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
