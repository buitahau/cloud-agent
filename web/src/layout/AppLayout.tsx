import { useEffect, useMemo, useState } from 'react';
import { DashboardOutlined, MenuOutlined, SearchOutlined, ThunderboltFilled, UnorderedListOutlined } from '@ant-design/icons';
import { Badge, Button, Drawer, Grid, Input, Layout, Menu, theme, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useRepos, useSummary } from '../api/queries';
import { Dot, healthTone } from '../components/StatusTag';
import { useNow } from '../components/ui';

/** Newest successful fetch time across all queries. */
function useLastUpdated() {
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const [at, setAt] = useState<number>(0);
  useEffect(() => {
    if (fetching) return;
    setAt(Math.max(0, ...qc.getQueryCache().getAll().map((q) => q.state.dataUpdatedAt)));
  }, [fetching, qc]);
  return { at, fetching: fetching > 0 };
}

function Freshness() {
  const { token } = theme.useToken();
  const { at, fetching } = useLastUpdated();
  const now = useNow();
  const age = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const stale = age !== null && age > 20;
  return (
    <Tooltip title={at ? `Auto-refreshes every 5s · last update ${new Date(at).toLocaleTimeString()}` : 'Loading…'}>
      <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>
        <Dot color={stale ? token.colorWarning : token.colorSuccess} live={fetching} />
        {age === null ? 'connecting' : stale ? `stale · ${age}s` : age < 3 ? 'up to date' : `updated ${age}s ago`}
      </span>
    </Tooltip>
  );
}

/** Jump straight to a job by (full or prefixed) id — handy when an id is pasted from logs. */
function JobJump() {
  const nav = useNavigate();
  const [v, setV] = useState('');
  return (
    <Input
      aria-label="Open job by id"
      allowClear
      prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
      placeholder="Open job by id…"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onPressEnter={() => {
        const id = v.trim();
        if (!id) return;
        nav(`/jobs/${encodeURIComponent(id.startsWith('job_') ? id : `job_${id}`)}`);
        setV('');
      }}
      style={{ maxWidth: 280 }}
    />
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { token } = theme.useToken();
  const repos = useRepos();
  const summary = useSummary();
  const running = summary.data?.running.length ?? 0;

  const selected = pathname === '/' ? 'overview' : pathname.startsWith('/jobs') ? 'jobs' : pathname.startsWith('/repos/') ? `repo:${decodeURIComponent(pathname.slice(7))}` : '';

  const items: MenuProps['items'] = useMemo(
    () => [
      { key: 'overview', icon: <DashboardOutlined />, label: <Link to="/" onClick={onNavigate}>Overview</Link> },
      {
        key: 'jobs',
        icon: <UnorderedListOutlined />,
        label: (
          <Link to="/jobs" onClick={onNavigate} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Jobs
            {running > 0 && (
              <Tooltip title={`${running} running`}>
                <Badge count={running} color={token.colorPrimary} size="small" />
              </Tooltip>
            )}
          </Link>
        ),
      },
      {
        type: 'group',
        key: 'repos',
        label: <div className="app-nav-label" style={{ padding: '12px 0 0' }}>Repositories</div>,
        children: (repos.data ?? []).map((r) => ({
          key: `repo:${r.id}`,
          icon: <span className="nav-dot"><Dot color={healthTone(token, r.health).solid} live={Boolean(r.running_job_id)} title={r.health.replace('_', ' ')} /></span>,
          label: (
            <Link
              to={`/repos/${encodeURIComponent(r.id)}`}
              onClick={onNavigate}
              title={r.enabled ? r.url_display : `${r.url_display} (disabled)`}
              style={r.enabled ? undefined : { opacity: 0.55 }}
            >
              {r.id}
            </Link>
          ),
        })),
      },
    ],
    [repos.data, running, token, onNavigate],
  );

  return (
    <>
      <Link to="/" className="app-brand" onClick={onNavigate}>
        <span className="app-brand-mark"><ThunderboltFilled /></span>
        <span>
          <div className="app-brand-name">cloud-agent</div>
          <div className="app-brand-sub">admin console</div>
        </span>
      </Link>
      <Menu mode="inline" selectedKeys={[selected]} items={items} style={{ borderInlineEnd: 0, paddingTop: 4 }} />
    </>
  );
}

export function AppLayout() {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const wide = screens.lg !== false; // treat "unknown" (first render) as wide
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  const vars = {
    '--c-primary': token.colorPrimary,
    '--c-primary-2': token.purple,
    '--c-text': token.colorText,
    '--c-text2': token.colorTextSecondary,
    '--c-text3': token.colorTextTertiary,
    '--c-bg': token.colorBgContainer,
    '--c-bg-layout': token.colorBgLayout,
    '--c-border': token.colorBorderSecondary,
    '--c-fill': token.colorFillSecondary,
    '--c-hover': token.colorFillQuaternary,
    '--c-code-bg': token.colorFillQuaternary,
    '--c-error': token.colorErrorText,
    '--c-mono': token.fontFamilyCode,
  } as React.CSSProperties;

  return (
    <Layout className="app-root" style={{ minHeight: '100vh', ...vars }}>
      {wide && (
        <Layout.Sider width={232} className="app-sider" theme="light">
          <div className="app-sider-inner"><Nav /></div>
        </Layout.Sider>
      )}
      <Layout>
        <header className="app-topbar">
          {!wide && <Button type="text" icon={<MenuOutlined />} aria-label="Open navigation" onClick={() => setDrawer(true)} />}
          <JobJump />
          <div style={{ flex: 1 }} />
          <Freshness />
        </header>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
      {!wide && (
        <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" size={260} closable={false} styles={{ body: { padding: 0 } }}>
          <Nav onNavigate={() => setDrawer(false)} />
        </Drawer>
      )}
    </Layout>
  );
}
