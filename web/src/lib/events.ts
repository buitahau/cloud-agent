import type { EventDataMap, JobEvent } from '../api/types';

type Ev<K extends keyof EventDataMap> = Extract<JobEvent, { type: K }>;

/** Display items built from the raw SSE events. */
export type StreamItem =
  | { kind: 'text'; key: string; seq: number | null; ev: Ev<'assistant_text'> }
  | { kind: 'thinking'; key: string; seq: number | null; ev: Ev<'thinking'> }
  | { kind: 'tool'; key: string; seq: number | null; use: Ev<'tool_use'> | null; result: Ev<'tool_result'> | null }
  | { kind: 'logs'; key: string; seq: number | null; lines: Ev<'log'>[] }
  | { kind: 'status'; key: string; seq: number | null; ev: Ev<'status'> }
  | { kind: 'init'; key: string; seq: number | null; ev: Ev<'init'> }
  | { kind: 'gap'; key: string; seq: number | null; ev: Ev<'gap'> }
  | { kind: 'result'; key: string; seq: number | null; ev: Ev<'result'> };

export type Category = 'messages' | 'thinking' | 'tools' | 'logs' | 'system';
export const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'tools', label: 'Tools' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'logs', label: 'Logs' },
  { key: 'system', label: 'System' },
];

export function categoryOf(it: StreamItem): Category {
  switch (it.kind) {
    case 'text': return 'messages';
    case 'thinking': return 'thinking';
    case 'tool': return 'tools';
    case 'logs': return 'logs';
    default: return 'system';
  }
}

/**
 * Group events for display: each tool_use is merged with its tool_result (matched by tool_use_id, so results
 * that arrive out of order still land on the right call), and consecutive log lines collapse into one item.
 * A tool_result whose tool_use was dropped from the buffer becomes a tool item without `use`.
 */
export function groupEvents(events: JobEvent[]): StreamItem[] {
  const out: StreamItem[] = [];
  const toolIdx = new Map<string, number>();
  for (const e of events) {
    switch (e.type) {
      case 'tool_use': {
        out.push({ kind: 'tool', key: e.key, seq: e.seq, use: e, result: null });
        if (e.data.id) toolIdx.set(e.data.id, out.length - 1);
        break;
      }
      case 'tool_result': {
        const i = e.data.tool_use_id ? toolIdx.get(e.data.tool_use_id) : undefined;
        const item = i === undefined ? undefined : out[i];
        if (item && item.kind === 'tool' && !item.result) {
          out[i!] = { ...item, result: e };
        } else {
          out.push({ kind: 'tool', key: e.key, seq: e.seq, use: null, result: e });
        }
        break;
      }
      case 'log': {
        const last = out[out.length - 1];
        if (last && last.kind === 'logs') out[out.length - 1] = { ...last, lines: [...last.lines, e] };
        else out.push({ kind: 'logs', key: e.key, seq: e.seq, lines: [e] });
        break;
      }
      case 'assistant_text': out.push({ kind: 'text', key: e.key, seq: e.seq, ev: e }); break;
      case 'thinking': out.push({ kind: 'thinking', key: e.key, seq: e.seq, ev: e }); break;
      case 'status': out.push({ kind: 'status', key: e.key, seq: e.seq, ev: e }); break;
      case 'init': out.push({ kind: 'init', key: e.key, seq: e.seq, ev: e }); break;
      case 'gap': out.push({ kind: 'gap', key: e.key, seq: e.seq, ev: e }); break;
      case 'result': out.push({ kind: 'result', key: e.key, seq: e.seq, ev: e }); break;
    }
  }
  return out;
}

/** Lower-cased searchable text of an item (for the stream's search box). */
export function itemText(it: StreamItem): string {
  let s: string;
  switch (it.kind) {
    case 'text': s = it.ev.data.text ?? ''; break;
    case 'thinking': s = it.ev.data.text ?? ''; break;
    case 'tool': {
      let input = '';
      try { input = JSON.stringify(it.use?.data.input ?? ''); } catch { /* ignore */ }
      s = `${it.use?.data.name ?? ''} ${input} ${it.result?.data.text ?? ''}`;
      break;
    }
    case 'logs': s = it.lines.map((l) => l.data.line).join('\n'); break;
    case 'status': s = `${it.ev.data.from ?? ''} ${it.ev.data.status}`; break;
    case 'init': s = `${it.ev.data.model ?? ''} ${(it.ev.data.tools ?? []).join(' ')}`; break;
    case 'gap': s = 'gap dropped'; break;
    case 'result': s = `${it.ev.data.status} ${it.ev.data.error ?? ''} ${it.ev.data.result ?? ''}`; break;
  }
  return s.toLowerCase();
}
