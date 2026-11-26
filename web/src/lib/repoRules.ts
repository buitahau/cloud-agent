// Client-side mirror of src/lib/validate.js (validateRepoUrl, isValidRepoId) and of the token rule in
// src/repoRegistry.js update(). Hints only: the server re-validates everything.
import type { RepoKind, RepoStatus } from '../api/types';

export const REPO_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED_REPO_IDS = ['admin', 'health', 'repos', 'run-agent'];
/** Whitespace or control characters (validateToken / validateRepoUrl reject them). */
export const TOKEN_BAD = /[\s\x00-\x1f\x7f]/;
export const MAX_TOKEN_LENGTH = 1000;

/** Kind of a git URL as the server classifies it, or null when it would be rejected. */
export function urlKind(url: string): RepoKind | null {
  if (!url || TOKEN_BAD.test(url) || url.startsWith('-')) return null;
  if (/^https:\/\//i.test(url)) return 'https';
  if (/^ssh:\/\//i.test(url)) return 'ssh';
  if (/^file:\/\/\//i.test(url) || url.startsWith('/')) return 'local';
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^/\\][^\\]*$/.test(url) || /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:\/[^\\]+$/.test(url)) return 'ssh';
  return null;
}

/** https origin a stored token is bound to (src/secrets.js originOf), or null. */
export function httpsOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** True if an https URL embeds user:pass (the server rejects it; catch it before the secret is sent). */
export function hasCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return Boolean(u.username || u.password);
  } catch {
    return false;
  }
}

/**
 * For PATCH: 'required' when the URL changes to https and the stored token can't follow (none stored, or another
 * origin, or the repo wasn't https); 'optional' (replace) for an unchanged/same-origin https URL; 'none' otherwise.
 */
export function tokenRequirement(cur: Pick<RepoStatus, 'url_display' | 'auth'>, nextUrl: string): 'required' | 'optional' | 'none' {
  if (urlKind(nextUrl) !== 'https') return 'none';
  if (nextUrl === cur.url_display) return 'optional';
  const o = httpsOrigin(nextUrl);
  const keeps = cur.auth.kind === 'https' && cur.auth.token !== null && o !== null && o === httpsOrigin(cur.url_display);
  return keeps ? 'optional' : 'required';
}

/** True when saving this URL deletes the stored token (leaving https, or another https origin). */
export function tokenWillDrop(cur: Pick<RepoStatus, 'url_display' | 'auth'>, nextUrl: string): boolean {
  if (nextUrl === cur.url_display || cur.auth.kind !== 'https' || !cur.auth.token) return false;
  return urlKind(nextUrl) !== 'https' || httpsOrigin(nextUrl) !== httpsOrigin(cur.url_display);
}

export const tokenHint = (hint: string) => (hint ? `…${hint}` : '(short token)');
