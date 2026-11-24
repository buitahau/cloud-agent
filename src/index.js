// src/index.js
// Entry point: load .env -> validate config -> Claude auth check (T1) -> wire modules -> listen.
// Exit code 1 with a clear message on any startup failure.

import 'dotenv/config'; // populates process.env from ./.env (does not override already-set vars)
import { loadConfig, redactConfig, ConfigError } from './config.js';
import { checkClaudeAuth, ClaudeAuthError } from './claudeAuth.js';
import { createJobStore } from './jobStore.js';
import { createGitSync } from './gitSync.js';
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
 *  3. auth = await checkClaudeAuth({ claudeBin, probe: config.claudeAuthProbe })
 *       ClaudeAuthError -> console.error(err.message); process.exit(1)
 *     console.log(`Claude auth OK (${auth.authMethod}, ${auth.version}${auth.probed ? ', probe passed' : ', probe skipped'})`)
 *  4. store  = createJobStore({ logsTailLines: config.logsTailLines })
 *     gitSync = createGitSync({ repoUrl, workspaceDir, sshKeyPath: gitSshKeyPath, token: gitToken, timeoutMs: gitTimeoutMs })
 *     runner = createClaudeRunner({ claudeBin, permissionMode, maxTurns, timeoutMs: jobTimeoutMs })
 *     worker = createWorker({ store, gitSync, claudeRunner: runner, workspaceDir })
 *     app    = createApp({ config, store, worker })
 *  5. server = await startServer(app, config.port)
 *     console.log(`Listening on :${server.address().port}`)
 *  6. SIGINT/SIGTERM (once): console.log('Shutting down'); server.close(); await worker.shutdown();
 *     process.exit(0). Needed because claude runs in its own process group (detached) and would otherwise
 *     outlive us.
 *  7. process.on('unhandledRejection') -> console.error, do NOT exit (service must stay up, T9).
 *
 * The workspace is NOT cloned at startup; the first job clones it (keeps startup fast, and a bad
 * REPO_URL shows up as a failed job per T9 instead of a crash).
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

  // 3. auth (T1)
  let auth;
  try {
    auth = await checkClaudeAuth({
      claudeBin: config.claudeBin,
      probe: config.claudeAuthProbe,
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
  const store = createJobStore({ logsTailLines: config.logsTailLines });
  const gitSync = createGitSync({
    repoUrl: config.repoUrl,
    workspaceDir: config.workspaceDir,
    sshKeyPath: config.gitSshKeyPath,
    token: config.gitToken,
    timeoutMs: config.gitTimeoutMs,
  });
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    permissionMode: config.claudePermissionMode,
    maxTurns: config.claudeMaxTurns,
    timeoutMs: config.jobTimeoutMs,
  });
  const worker = createWorker({ store, gitSync, claudeRunner: runner, workspaceDir: config.workspaceDir });
  const app = createApp({ config, store, worker });

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
