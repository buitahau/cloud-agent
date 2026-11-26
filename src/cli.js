// src/cli.js
// Operator commands:
//  - `backup <path>`: a consistent online copy of DB_FILE via VACUUM INTO (a plain cp of a WAL database can miss
//    committed pages). Needs only DB_FILE: no MASTER_KEY, no migration. The copy holds encrypted tokens only;
//    MASTER_KEY must be kept separately.
//  - `import <file>`: import a repos.json + the token env vars its `auth.tokenEnv` entries name into an EMPTY
//    database. Needs the full service config (MASTER_KEY, API_KEY, ...). REPOS_FILE / GIT_TOKEN* are allowed here,
//    because this is what reads them.
// It never edits existing repos (§0 decision 4 of docs/SQLITE_REPOS_PLAN.md): use the admin dashboard/API.
//
//   node src/cli.js backup ./data/backups/2026-01-01.db
//   node src/cli.js import repos.json

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, closeDb } from './db.js';
import { loadConfig, ConfigError, withoutRepoImportVars } from './config.js';
import { migrate } from './db/migrations.js';
import { createRepoStore } from './repoStore.js';
import { importReposFile } from './repoImport.js';

const USAGE = [
  'usage: node src/cli.js backup <path>   copy DB_FILE to <path> (<path> must not exist)',
  '       node src/cli.js import <file>   import a repos.json (+ the token env vars it names) into an empty DB_FILE',
].join('\n');

/**
 * @param {string[]} argv  arguments after the script name
 * @param {{ env?: Record<string, string|undefined>, cwd?: string, out?: (m: string) => void, err?: (m: string) => void }} [io]
 * @returns {number} exit code (0 ok, 1 failure, 2 usage)
 */
export function runCli(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  if (argv[0] === 'import' && argv.length === 2 && argv[1]) return runImport(argv[1], { env, cwd, out, err });
  if (argv[0] !== 'backup' || argv.length !== 2 || !argv[1]) {
    err(USAGE);
    return 2;
  }
  const dbFile = path.resolve(cwd, env.DB_FILE?.trim() || './data/cloud-agent.db');
  if (!fs.existsSync(dbFile)) {
    err(`database not found: ${dbFile} (set DB_FILE)`);
    return 1;
  }
  const dest = path.resolve(cwd, argv[1]);
  if (fs.existsSync(dest)) {
    err(`backup target already exists: ${dest}`);
    return 1;
  }
  let db;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const old = process.umask(0o077); // VACUUM INTO creates the file 0644 otherwise
    try {
      db = openDb(dbFile);
      db.prepare('VACUUM INTO ?').run(dest);
    } finally {
      process.umask(old);
      if (db) closeDb(db);
    }
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o600);
  } catch (e) {
    err(`backup failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  out(`Backed up ${dbFile} to ${dest} (${fs.statSync(dest).size} bytes). Keep MASTER_KEY separate from backups.`);
  return 0;
}

/**
 * `import <file>`: see the header. Never prints token values (ImportError / ConfigError messages hold none).
 * @param {string} fileArg
 * @param {{ env: Record<string, string|undefined>, cwd: string, out: (m: string) => void, err: (m: string) => void }} io
 * @returns {number}
 */
function runImport(fileArg, { env, cwd, out, err }) {
  let config;
  try {
    config = loadConfig(withoutRepoImportVars(env), { cwd });
  } catch (e) {
    if (e instanceof ConfigError) { err(e.message); return 1; }
    throw e;
  }
  const file = path.resolve(cwd, fileArg);
  // Check before opening (and so creating) the database: a mistyped path should leave nothing behind.
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    err(`Import of repos.json failed (nothing was imported):\n  - ${file} not found`);
    return 1;
  }
  let db;
  try {
    db = openDb(config.dbFile);
    migrate(db);
    const store = createRepoStore({ db, keyRing: config.keyRing });
    const r = importReposFile({ store, file, config, env, cwd, log: { warn: err } });
    out(`Imported ${r.count} repo${r.count === 1 ? '' : 's'} (${r.ids.join(', ') || 'none'}) from ${file} into ${config.dbFile}.`);
    out('Next: restart the service to load them; remove the token variables (auth.tokenEnv, GIT_TOKEN_*) from .env and your shell (the service refuses to start while GIT_TOKEN/GIT_TOKEN_* are set); delete the file (it is not read again).');
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e)); // ImportError / migrate errors never contain token values
    return 1;
  } finally {
    if (db) closeDb(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await import('dotenv/config');
  process.exitCode = runCli(process.argv.slice(2));
}
