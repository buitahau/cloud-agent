import { Layout, Menu, Typography, theme } from 'antd';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation } from 'react-router';
import { useEffect, useState } from 'react';

/** Newest successful fetch time across all queries, shown as "updated HH:MM:SS". */
function useLastUpdated() {
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const [at, setAt] = useState<number>(0);
  useEffect(() => {
    if (fetching) return;
    const newest = Math.max(0, ...qc.getQueryCache().getAll().map((q) => q.state.dataUpdatedAt));
    setAt(newest);
  }, [fetching, qc]);
  return at;
}

export function AppLayout() {
  const { pathname } = useLocation();
  const { token } = theme.useToken();
  const updated = useLastUpdated();
  const selected = pathname === '/' ? 'overview' : pathname === '/jobs' ? 'jobs' : '';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24, paddingInline: 24 }}>
        <Link to="/" style={{ color: '#fff', fontWeight: 600, fontSize: 16, whiteSpace: 'nowrap' }}>
          cloud-agent <span style={{ opacity: 0.6, fontWeight: 400 }}>admin</span>
        </Link>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          style={{ flex: 1, minWidth: 0 }}
          items={[
            { key: 'overview', label: <Link to="/">Overview</Link> },
            { key: 'jobs', label: <Link to="/jobs">Jobs</Link> },
          ]}
        />
        <Typography.Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }} aria-live="polite">
          {updated ? `updated ${new Date(updated).toLocaleTimeString()}` : ''}
        </Typography.Text>
      </Layout.Header>
      <Layout.Content style={{ padding: 24, maxWidth: 1400, width: '100%', margin: '0 auto', color: token.colorText }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
