import type { EventDataMap, EventType } from '../api/types';

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(4)}`);

export const upt = (s: number) =>
  s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;

export const shortId = (id: string) => `${id.slice(0, 12)}…`;

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const label = (s: string) => s.replace('_', ' ');

/** One-line text for an SSE event (port of the old dashboard's describe()). */
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
