// src/lib/csrf.js
// CSRF guard for the Basic-auth admin. Browsers attach cached Basic credentials automatically, so every
// non-GET/HEAD request must prove it came from our own page. ALL must hold, else 403 { error }:
//  1. Content-Type is application/json (forms can't send it; it forces a CORS preflight)
//  2. X-Admin-Request: 1 (custom header -> preflight, which this app never approves: no CORS headers anywhere)
//  3. Origin, when present, has the request's host (and scheme, when known through a trusted proxy)
//  4. Sec-Fetch-Site is absent (non-browser clients, e.g. curl) or "same-origin"
// Client contract (web/src/api/client.ts sendJson() in PR 4, curl in the README): send both headers.

export const ADMIN_REQUEST_HEADER = 'x-admin-request';
const SAFE_METHODS = new Set(['GET', 'HEAD']);
/** First value of a comma-separated (proxy-appended) header. @param {unknown} v */
const first = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : '');

/**
 * @param {import('express').Request} req
 * @param {{ trustProxy?: boolean }} [opts]  trustProxy: take host/scheme from X-Forwarded-Host/-Proto (TRUST_PROXY)
 * @returns {string|null} why the request is refused, or null if it passes
 */
export function csrfProblem(req, { trustProxy = false } = {}) {
  const ct = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return 'Content-Type must be application/json';
  if (req.get(ADMIN_REQUEST_HEADER) !== '1') return 'X-Admin-Request: 1 header required';
  const origin = req.get('origin');
  if (origin !== undefined) {
    const host = (trustProxy && first(req.get('x-forwarded-host'))) || req.get('host') || '';
    const proto = trustProxy ? first(req.get('x-forwarded-proto')).toLowerCase() : '';
    let o;
    let expected;
    try {
      o = new URL(origin);
      // Without a known scheme, use the origin's own so default ports normalise the same way on both sides.
      expected = new URL(`${proto || o.protocol.replace(/:$/, '')}://${host}`);
    } catch {
      return 'cross-origin request'; // also "null"
    }
    if (o.host !== expected.host || (proto && o.protocol !== expected.protocol)) return 'cross-origin request';
  }
  const site = req.get('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return 'cross-site request';
  return null;
}

/** @param {{ trustProxy?: boolean }} [opts] @returns {import('express').RequestHandler} */
export function csrfGuard(opts = {}) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const problem = csrfProblem(req, opts);
    if (problem) {
      res.status(403).json({ error: `forbidden: ${problem}` });
      return;
    }
    next();
  };
}
