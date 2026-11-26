// src/cli.js
// Operator commands. Only `backup <path>`: a consistent online copy of DB_FILE via VACUUM INTO (a plain cp of a
// WAL database can miss committed pages). Needs only DB_FILE: no MASTER_KEY, no migration. The copy holds
// encrypted tokens only; MASTER_KEY must be kept separately.
//
//   node src/cli.js backup ./data/backups/2026-01-01.db

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, closeDb } from './db.js';

const USAGE = 'usage: node src/cli.js backup <path>   (copy DB_FILE to <path>; <path> must not exist)';

/**
 * @param {string[]} argv  arguments after the script name
 * @param {{ env?: Record<string, string|undefined>, cwd?: string, out?: (m: string) => void, err?: (m: string) => void }} [io]
 * @returns {number} exit code (0 ok, 1 failure, 2 usage)
 */
export function runCli(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {}) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await import('dotenv/config');
  process.exitCode = runCli(process.argv.slice(2));
}
