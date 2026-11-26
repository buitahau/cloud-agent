import type { EventDataMap, EventType } from '../api/types';

/** Relative time: "12s ago", "5m ago", "3h ago", "4d ago", then a short date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Absolute timestamp for tooltips: "Nov 25, 2026, 15:42:51". */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** Wall-clock time only: "15:42:51". */
export const clock = (iso: string | number) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const money = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
};

export const upt = (s: number) =>
  s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400
    ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;

/** Job ids look like "job_<32 hex>": show the first 8 hex chars (git-style). Full id stays in tooltips/copy. */
export const shortId = (id: string) => id.replace(/^job_/, '').slice(0, 8);

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const label = (s: string) => s.replaceAll('_', ' ');

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One-line text for an SSE event. */
export function describe<K extends EventType>(type: K, data: EventDataMap[K]): string {
  const d = data as Record<string, any>;
  switch (type) {
    case 'status': return `${d.from ?? ''} → ${d.status}`;
    case 'init': return `model ${d.model ?? '?'} · ${Array.isArray(d.tools) ? d.tools.length : 0} tools`;
    case 'assistant_text': return d.text ?? '';
    case 'thinking': return d.redacted ? '(redacted)' : (d.text ?? '');
    case 'tool_use': return `${d.name ?? '?'} ${truncate(JSON.stringify(d.input ?? {}), 600)}`;
    case 'tool_result': return `${d.is_error ? '[error] ' : ''}${truncate(d.text ?? '', 1200)}`;
    case 'log': return d.line ?? '';
    case 'gap': return `${d.dropped} earlier events were dropped from the buffer`;
    case 'result': return `${d.status}${d.error ? `: ${d.error}` : ''}`;
    default: return truncate(JSON.stringify(d), 600);
  }
}

/** Short, human summary of a tool call's input: the most telling field (path, command, pattern, url…). */
export function toolSummary(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return truncate(String(input), 200);
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'notebook_path']) {
    if (typeof o[k] === 'string' && o[k]) return truncate((o[k] as string).split('\n')[0], 200);
  }
  const firstStr = Object.values(o).find((v) => typeof v === 'string' && v);
  if (typeof firstStr === 'string') return truncate(firstStr.split('\n')[0], 200);
  return truncate(JSON.stringify(o), 200);
}

/** Pretty JSON for display; compact on one line when short. */
export function prettyJson(v: unknown): string {
  let compact: string;
  try {
    compact = JSON.stringify(v ?? {});
  } catch {
    return String(v);
  }
  return compact.length <= 100 ? compact : JSON.stringify(v, null, 2);
}

const scalar = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
/** Audit details as text lines: "url: a → b", "token: set …a1b2", "workspace: wiped". */
export function auditLines(details: Record<string, unknown>): string[] {
  return Object.entries(details ?? {}).map(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'from' in v && 'to' in v) {
      const o = v as { from: unknown; to: unknown };
      return `${k}: ${scalar(o.from)} → ${scalar(o.to)}`;
    }
    return `${k}: ${scalar(v)}`;
  });
}
