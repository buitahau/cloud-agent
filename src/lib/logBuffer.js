// src/lib/logBuffer.js
// Bounded per-job line buffer. Source of the `logs_tail` API field.

/** Longest single stored line; longer lines are cut and suffixed with "…[truncated]". */
export const MAX_LINE_LENGTH = 2000;

/**
 * Ring buffer of text lines.
 *
 * - push(text): split text on /\r?\n/, drop a single trailing empty element (from a final newline),
 *   truncate each line to MAX_LINE_LENGTH, append; when size > capacity drop oldest lines.
 * - tail(n): last n lines joined with "\n" ("" when empty).
 * - size: current number of stored lines.
 */
export class LogBuffer {
  /** @param {number} [capacity=500] */
  constructor(capacity = 500) {
    /** @type {number} */
    this.capacity = capacity;
    /** @type {string[]} */
    this.lines = [];
  }

  /** @param {string} text */
  push(text) {
    const parts = String(text).split(/\r?\n/);
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    for (const raw of parts) {
      const line = raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}…[truncated]` : raw;
      this.lines.push(line);
    }
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /**
   * @param {number} n
   * @returns {string}
   */
  tail(n) {
    if (!(n > 0) || this.lines.length === 0) return '';
    return this.lines.slice(-n).join('\n');
  }

  /** @returns {number} */
  get size() {
    return this.lines.length;
  }
}

/**
 * Turns chunked stream data into complete lines. Holds a partial last line until more data
 * arrives or flush() is called. Used by processRunner for onLine callbacks.
 */
export class LineSplitter {
  /** @param {(line: string) => void} onLine */
  constructor(onLine) {
    this.onLine = onLine;
    this.partial = '';
  }

  /** @param {string} chunk decoded utf8 text */
  write(chunk) {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    // A chunk ending in '\r' may be the first half of '\r\n'; keep it in partial (stripped on emit).
    for (const line of parts) this.onLine(line);
  }

  /** Emit any remaining partial line (if non-empty). */
  flush() {
    let rest = this.partial;
    this.partial = '';
    if (rest.endsWith('\r')) rest = rest.slice(0, -1);
    if (rest.length > 0) this.onLine(rest);
  }
}
