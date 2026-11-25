import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { Breadcrumb, Button, theme, Tooltip } from 'antd';
import { Link } from 'react-router';
import { JOB_STATUSES, type StatusCounts } from '../api/types';
import { ago, label, stamp } from '../lib/format';
import { statusTone } from './StatusTag';

// ---- shared clock: one interval for every relative time on the page ----
const subs = new Set<() => void>();
let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer) timer = setInterval(() => { nowMs = Date.now(); subs.forEach((f) => f()); }, 1000);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) { clearInterval(timer); timer = undefined; }
  };
}
/** Current time, re-rendering every second while mounted. */
export const useNow = () => useSyncExternalStore(subscribe, () => nowMs);

/** "3m ago" that keeps itself fresh, with the absolute time in a tooltip. */
export function TimeAgo({ at, prefix }: { at: string | null | undefined; prefix?: string }) {
  const now = useNow();
  if (!at) return <span className="muted">—</span>;
  return (
    <Tooltip title={stamp(at)}>
      <time dateTime={at} className="nowrap">{prefix}{ago(at, now)}</time>
    </Tooltip>
  );
}

export function PageHeader({
  crumbs, title, sub, extra,
}: { crumbs?: { to?: string; label: React.ReactNode }[]; title: React.ReactNode; sub?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <>
      {crumbs && (
        <Breadcrumb
          style={{ marginBottom: 8 }}
          items={crumbs.map((c) => ({ title: c.to ? <Link to={c.to}>{c.label}</Link> : c.label }))}
        />
      )}
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="page-title">{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {extra && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{extra}</div>}
      </div>
    </>
  );
}

export function StatTile({
  label: l, icon, color, value, unit, foot, to, testId,
}: {
  label: string; icon: React.ReactNode; color: string; value: React.ReactNode; unit?: React.ReactNode; foot?: React.ReactNode; to?: string; testId?: string;
}) {
  const inner = (
    <>
      <div className="stat-label">
        <span className="stat-icon" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{icon}</span>
        {l}
      </div>
      <div className="stat-value" data-testid={testId}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="stat-foot">{foot}</div>
    </>
  );
  return to ? <Link className="stat" to={to}>{inner}</Link> : <div className="stat">{inner}</div>;
}

/** Stacked bar of job counts by status, with an optional legend. */
export function StatusDistribution({ counts, legend = true }: { counts: StatusCounts; legend?: boolean }) {
  const { token } = theme.useToken();
  const present = JOB_STATUSES.filter((s) => counts[s] > 0);
  const total = present.reduce((a, s) => a + counts[s], 0);
  if (!total) return <div className="dist" aria-label="no jobs" />;
  return (
    <div>
      <div className="dist" role="img" aria-label={present.map((s) => `${counts[s]} ${s}`).join(', ')}>
        {present.map((s) => (
          <Tooltip key={s} title={`${counts[s]} ${label(s)}`}>
            <span style={{ flex: counts[s], background: statusTone(token, s).solid }} />
          </Tooltip>
        ))}
      </div>
      {legend && (
        <div className="legend">
          {present.map((s) => (
            <span key={s}>
              <i className="dot" style={{ background: statusTone(token, s).solid }} />
              <span className="num">{counts[s]}</span> {label(s)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Clipboard API needs a secure context; fall back to a hidden textarea on plain http. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Icon button that copies text and briefly shows a check mark. */
export function CopyButton({ text, label: l = 'Copy', size = 'small' }: { text: string; label?: string; size?: 'small' | 'middle' }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Tooltip title={done ? 'Copied' : l}>
      <Button
        type="text"
        size={size}
        aria-label={l}
        icon={done ? <CheckOutlined /> : <CopyOutlined />}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(text).then((ok) => ok && setDone(true));
        }}
      />
    </Tooltip>
  );
}

export function Panel({ title, extra, children, pad = true, style, testId }: { title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; pad?: boolean; style?: React.CSSProperties; testId?: string }) {
  return (
    <section className="panel" style={style} data-testid={testId}>
      {title && (
        <div className="panel-head">
          {title}
          {extra && <div className="extra">{extra}</div>}
        </div>
      )}
      <div className={pad ? 'panel-pad' : undefined}>{children}</div>
    </section>
  );
}
