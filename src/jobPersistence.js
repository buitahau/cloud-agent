// src/jobPersistence.js
// Optional append-only JSONL file of job snapshots (JOBS_FILE), so job history survives restarts.
// One line per status change; the last line for an id wins. Compacted at startup and whenever the file
// grows past `compactAfterLines`. Synchronous on purpose (matches the synchronous job store; ~5 writes/job).
// Failures are logged and swallowed: persistence must never break a job.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {Object} opts
 * @param {string} opts.file                     absolute path
 * @param {() => object[]} opts.getSnapshots     current jobs to keep when compacting
 * @param {number} [opts.compactAfterLines=2000]
 * @param {{ warn: Function, error: Function }} [opts.logger=console]
 */
export function createJobPersistence(opts) {
  const { file, getSnapshots } = opts;
  const compactAfterLines = opts.compactAfterLines ?? 2000;
  const logger = opts.logger ?? console;
  let lines = 0;

  return {
    file,

    /**
     * Read the file. Last line per id wins; unparseable lines (e.g. a partial line after a crash) are skipped.
     * Missing file -> [].
     * @returns {object[]}
     */
    load() {
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return [];
        throw err;
      }
      /** @type {Map<string, object>} */
      const byId = new Map();
      let skipped = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec.id === 'string') { byId.delete(rec.id); byId.set(rec.id, rec); } else skipped++;
        } catch {
          skipped++;
        }
      }
      if (skipped) logger.warn(`[jobs-file] skipped ${skipped} unreadable line(s) in ${file}`);
      return [...byId.values()];
    },

    /** @param {object} snapshot */
    append(snapshot) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
        lines++;
        if (lines > compactAfterLines) this.compact(getSnapshots());
      } catch (err) {
        logger.error(`[jobs-file] could not write ${file}:`, err?.message ?? err);
      }
    },

    /**
     * Atomically rewrite the file with one line per snapshot (temp file + rename).
     * @param {object[]} snapshots
     */
    compact(snapshots) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, snapshots.map((s) => `${JSON.stringify(s)}\n`).join(''), { mode: 0o600 });
        fs.renameSync(tmp, file);
        lines = snapshots.length;
      } catch (err) {
        logger.error(`[jobs-file] could not compact ${file}:`, err?.message ?? err);
      }
    },
  };
}
