import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownOutlined, BulbOutlined, CheckOutlined, CloseOutlined, CodeOutlined, EditOutlined, FileTextOutlined,
  GlobalOutlined, LoadingOutlined, MessageOutlined, ProfileOutlined, RightOutlined, SearchOutlined, ToolOutlined,
} from '@ant-design/icons';
import { Alert, Button, Empty, Input, Tooltip, theme } from 'antd';
import type { JobEvent } from '../api/types';
import { CATEGORIES, categoryOf, groupEvents, itemText, type Category, type StreamItem } from '../lib/events';
import { label, prettyJson, toolSummary } from '../lib/format';
import { StatusTag } from './StatusTag';
import { TextBlock } from './TextBlock';
import { CopyButton } from './ui';

function toolIcon(name: string | undefined) {
  switch (name) {
    case 'Bash': return <CodeOutlined />;
    case 'Read': return <FileTextOutlined />;
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return <EditOutlined />;
    case 'Grep': case 'Glob': return <SearchOutlined />;
    case 'WebFetch': case 'WebSearch': return <GlobalOutlined />;
    default: return <ToolOutlined />;
  }
}

function Icon({ color, children, label: l }: { color: string; children: React.ReactNode; label: string }) {
  return (
    <span className="ev-icon" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }} title={l} aria-label={l} role="img">
      {children}
    </span>
  );
}

function Seq({ seq }: { seq: number | null }) {
  return <span className="ev-seq">{seq !== null ? `#${seq}` : ''}</span>;
}

const ToolItem = memo(function ToolItem({ it, live, defaultOpen }: { it: Extract<StreamItem, { kind: 'tool' }>; live: boolean; defaultOpen: boolean }) {
  const { token } = theme.useToken();
  const err = Boolean(it.result?.data.is_error);
  const [open, setOpen] = useState(defaultOpen || err);
  useEffect(() => { if (err) setOpen(true); }, [err]);
  const name = it.use?.data.name ?? 'tool result';
  const summary = it.use ? toolSummary(it.use.data.input) : 'call not in buffer';
  const input = it.use ? prettyJson(it.use.data.input) : '';
  const output = it.result?.data.text ?? '';
  const state = it.result ? (err ? 'error' : 'ok') : live ? 'pending' : 'none';
  const color = err ? token.colorError : token.colorWarning;

  return (
    <div className="ev">
      <Seq seq={it.seq} />
      <Icon color={color} label={`tool ${name}`}>{toolIcon(it.use?.data.name)}</Icon>
      <div className="ev-body">
        <button type="button" className="ev-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <RightOutlined style={{ fontSize: 10, transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none', color: token.colorTextTertiary }} />
          <span className="ev-tool-name">{name}</span>
          <span className="ev-tool-arg mono ellipsis">{summary}</span>
          <span style={{ flex: 'none', fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            {state === 'ok' && <span style={{ color: token.colorSuccessText }}><CheckOutlined /> {output.split('\n').length} line{output.split('\n').length === 1 ? '' : 's'}</span>}
            {state === 'error' && <span style={{ color: token.colorErrorText }}><CloseOutlined /> error</span>}
            {state === 'pending' && <span style={{ color: token.colorPrimaryText }}><LoadingOutlined /> running</span>}
            {state === 'none' && <span className="muted">no result</span>}
          </span>
        </button>
        {open && (
          <div className="ev-tool-detail">
            {it.use && (
              <div>
                <div className="ev-sub" style={{ display: 'flex', alignItems: 'center' }}>Input <span style={{ marginLeft: 'auto' }}><CopyButton text={input} label="Copy input" /></span></div>
                <pre className="codebox mono">{input}</pre>
              </div>
            )}
            {it.result && (
              <div>
                <div className="ev-sub" style={{ display: 'flex', alignItems: 'center' }}>
                  {err ? 'Error output' : 'Output'}
                  {it.result.data.truncated && <span style={{ marginLeft: 6, textTransform: 'none', fontWeight: 400 }}>(truncated by server)</span>}
                  <span style={{ marginLeft: 'auto' }}><CopyButton text={output} label="Copy output" /></span>
                </div>
                <pre className={`codebox mono${err ? ' err' : ''}`}>{output || '(empty)'}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

const LogsItem = memo(function LogsItem({ it }: { it: Extract<StreamItem, { kind: 'logs' }> }) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const n = it.lines.length;
  const shown = open || n <= 3 ? it.lines : it.lines.slice(-3);
  return (
    <div className="ev">
      <Seq seq={it.seq} />
      <Icon color={token.colorTextTertiary} label="log">
        <ProfileOutlined />
      </Icon>
      <div className="ev-body ev-logs mono">
        {!open && n > 3 && (
          <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setOpen(true)}>
            show {n - 3} earlier log line{n - 3 === 1 ? '' : 's'}
          </Button>
        )}
        {shown.map((l) => (
          <div key={l.key} className="ev-text">{l.data.line}</div>
        ))}
      </div>
    </div>
  );
});

const Item = memo(function Item({ it, live, openAll }: { it: StreamItem; live: boolean; openAll: boolean }) {
  const { token } = theme.useToken();
  switch (it.kind) {
    case 'text':
      return (
        <div className="ev">
          <Seq seq={it.seq} />
          <Icon color={token.colorPrimary} label="assistant message"><MessageOutlined /></Icon>
          <div className="ev-body"><TextBlock text={it.ev.data.text ?? ''} limit={1500} /></div>
        </div>
      );
    case 'thinking':
      return (
        <div className="ev">
          <Seq seq={it.seq} />
          <Icon color={token.purple} label="thinking"><BulbOutlined /></Icon>
          <div className="ev-body">
            {it.ev.data.redacted ? <span className="muted">(redacted thinking)</span> : <TextBlock text={it.ev.data.text ?? ''} limit={280} className="ev-think" />}
          </div>
        </div>
      );
    case 'tool':
      return <ToolItem it={it} live={live} defaultOpen={openAll} />;
    case 'logs':
      return <LogsItem it={it} />;
    case 'status':
      return (
        <div className="ev-divider" role="separator">
          <span className="ev-seq">{it.seq !== null ? `#${it.seq}` : ''}</span>
          <span className="ev-rule" />
          <StatusTag status={it.ev.data.status} hint={false} />
          {it.ev.data.from && <span>from {label(it.ev.data.from)}</span>}
        </div>
      );
    case 'init': {
      const tools = it.ev.data.tools ?? [];
      return (
        <div className="ev-divider" role="separator">
          <span className="ev-seq">{it.seq !== null ? `#${it.seq}` : ''}</span>
          <span className="ev-rule" />
          <span>
            Session started · model <span className="mono">{it.ev.data.model ?? '?'}</span> ·{' '}
            <Tooltip title={tools.join(', ') || 'none'}><span style={{ textDecoration: 'underline dotted' }}>{tools.length} tools</span></Tooltip>
          </span>
        </div>
      );
    }
    case 'gap':
      return (
        <div style={{ padding: '6px 16px 6px 60px' }}>
          <Alert type="info" showIcon title={`${it.ev.data.dropped} earlier events were dropped from the server's buffer`} />
        </div>
      );
    case 'result': {
      const ok = it.ev.data.status === 'succeeded';
      return (
        <div style={{ padding: '10px 16px 6px 60px' }}>
          <Alert
            type={ok ? 'success' : 'error'}
            showIcon
            title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>Job finished <StatusTag status={it.ev.data.status} hint={false} /></span>}
            description={it.ev.data.error ? <TextBlock text={it.ev.data.error} mono limit={600} /> : null}
          />
        </div>
      );
    }
  }
});

/**
 * Readable live event feed: grouped tool calls, filter chips with counts, text search, auto-follow when scrolled to
 * the bottom and a "jump to latest" button otherwise. All event text is untrusted and rendered as plain text.
 */
export function EventStream({ events, live }: { events: JobEvent[]; live: boolean }) {
  const items = useMemo(() => groupEvents(events), [events]);
  const [hidden, setHidden] = useState<Category[]>([]);
  const [query, setQuery] = useState('');
  const [openAll, setOpenAll] = useState(false);
  const [openGen, setOpenGen] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const seenRef = useRef(0);

  const counts = useMemo(() => {
    const c: Record<Category, number> = { messages: 0, thinking: 0, tools: 0, logs: 0, system: 0 };
    for (const it of items) c[categoryOf(it)] += it.kind === 'logs' ? it.lines.length : 1;
    return c;
  }, [items]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => items.filter((it) => !hidden.includes(categoryOf(it)) && (!q || itemText(it).includes(q))),
    [items, hidden, q],
  );

  // Follow the tail only while the user is at the bottom; otherwise count what arrived meanwhile.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      seenRef.current = shown.length;
    }
  }, [shown]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => {
      const b = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      atBottomRef.current = b;
      if (b) seenRef.current = el.childElementCount;
      setAtBottom(b);
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);

  const jump = useCallback(() => {
    const el = box.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  const unseen = Math.max(0, shown.length - seenRef.current);
  const present = CATEGORIES.filter((c) => counts[c.key] > 0);

  return (
    <div>
      <div className="stream-toolbar">
        {present.map((c) => {
          const on = !hidden.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              className="chip"
              aria-pressed={on}
              onClick={() => setHidden(on ? [...hidden, c.key] : hidden.filter((h) => h !== c.key))}
            >
              {c.label} <span className="n">{counts[c.key]}</span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <Button size="small" type="text" onClick={() => { setOpenAll(!openAll); setOpenGen(openGen + 1); }}>
          {openAll ? 'Collapse tools' : 'Expand tools'}
        </Button>
        <Input
          size="small"
          allowClear
          aria-label="Search events"
          placeholder="Search events"
          prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 200 }}
        />
      </div>
      <div className="stream-wrap">
        <div ref={box} className="stream" role="log" aria-live="off" aria-label="Job events" tabIndex={0}>
          {shown.length === 0 ? (
            <Empty
              style={{ marginTop: 48 }}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={items.length === 0 ? (live ? 'Waiting for the first event…' : 'No events recorded') : 'No events match the filters'}
            />
          ) : (
            shown.map((it) => <Item key={`${it.key}-${openGen}`} it={it} live={live} openAll={openAll} />)
          )}
        </div>
        {!atBottom && shown.length > 0 && (
          <Button className="jump-latest" type="primary" shape="round" size="small" icon={<ArrowDownOutlined />} onClick={jump}>
            {unseen > 0 ? `${unseen} new · jump to latest` : 'Jump to latest'}
          </Button>
        )}
      </div>
    </div>
  );
}
