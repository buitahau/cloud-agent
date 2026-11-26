// Built from origin + fixed path (never location.href): if the page was opened as https://user:pass@host/admin/,
// relative URLs would inherit the credentials and fetch() refuses those.
export const API_BASE = `${location.origin}/admin/api`;

export class ApiError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Server errors are { error, problems? } (src/admin.js fail()); anything else becomes "HTTP <status>". */
async function toApiError(res: Response): Promise<ApiError> {
  let msg = `HTTP ${res.status}`;
  let problems: string[] = [];
  try {
    const b = (await res.json()) as { error?: unknown; problems?: unknown };
    if (typeof b.error === 'string' && b.error) msg = b.error;
    if (Array.isArray(b.problems)) problems = b.problems.filter((p): p is string => typeof p === 'string');
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, msg, problems);
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/**
 * Admin write. Sends both CSRF headers (src/lib/csrf.js): Content-Type: application/json + X-Admin-Request: 1,
 * on every method including DELETE. 204 -> undefined. Secrets go in the body only, never in the path.
 */
export async function sendJson<T = void>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-admin-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const enc = encodeURIComponent;
