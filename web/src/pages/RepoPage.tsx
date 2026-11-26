import {
  BranchesOutlined, CheckCircleOutlined, CloudSyncOutlined, DeleteOutlined, EditOutlined, FolderOutlined, KeyOutlined,
  PlayCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Col, Row, Skeleton, Tabs, theme, Tooltip } from 'antd';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useRepo } from '../api/queries';
import { AuditLog } from '../components/AuditLog';
import { JobsTable } from '../components/JobsTable';
import { QueryError } from '../components/QueryError';
import { DeleteRepoModal, EnabledSwitch } from '../components/RepoActions';
import { AuthInfo } from '../components/RepoAuth';
import { RepoFormModal } from '../components/RepoForm';
import { DisabledTag, HealthTag } from '../components/StatusTag';
import { TokenModal } from '../components/TokenModal';
import { CopyButton, PageHeader, Panel, StatTile, StatusDistribution, TimeAgo } from '../components/ui';
import { dur, shortId } from '../lib/format';

export function RepoPage() {
  const { id = '' } = useParams();
  const { token } = theme.useToken();
  const repo = useRepo(id);
  const [dialog, setDialog] = useState<null | 'edit' | 'token' | 'delete'>(null);
  const [tab, setTab] = useState('jobs');

  if (repo.error) return <QueryError error={repo.error} what={`Repository "${id}"`} />;
  if (!repo.data) return <Skeleton active paragraph={{ rows: 6 }} />;
  const r = repo.data;
  const c = r.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const finished = c.succeeded + c.failed + c.timeout;
  const rate = finished ? Math.round((c.succeeded / finished) * 100) : null;
  const ls = r.last_sync;

  return (
    <>
      <PageHeader
        crumbs={[{ to: '/', label: 'Overview' }, { label: 'Repositories' }, { label: r.id }]}
        title={<>{r.id} {!r.enabled && <DisabledTag large />} <HealthTag health={r.health} large /></>}
        sub={
          <>
            <span className="mono">{r.url_display}<CopyButton text={r.url_display} label="Copy repo URL" /></span>
            <span><BranchesOutlined /> default {r.default_branch}</span>
            <AuthInfo auth={r.auth} />
          </>
        }
        extra={
          <>
            <EnabledSwitch repo={r} />
            {r.auth.kind === 'https' && (
              <Button icon={<KeyOutlined />} onClick={() => setDialog('token')}>{r.auth.token ? 'Replace token' : 'Set token'}</Button>
            )}
            <Button icon={<EditOutlined />} onClick={() => setDialog('edit')}>Edit</Button>
            <Button danger icon={<DeleteOutlined />} onClick={() => setDialog('delete')}>Delete</Button>
          </>
        }
      />

      {!r.enabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="This repository is disabled"
          description="New jobs are refused (409) and queued jobs fail. A running job finishes normally."
        />
      )}
      {r.auth.kind === 'https' && !r.auth.token && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="No token stored"
          description="Syncs of this https repo fail until a token is set."
          action={<Button size="small" onClick={() => setDialog('token')}>Set token</Button>}
        />
      )}

      {ls && !ls.ok && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={<>Last sync failed <TimeAgo at={ls.at} /></>}
          description={<pre className="codebox err" style={{ marginTop: 6 }}>{ls.error ?? 'unknown error'}</pre>}
          action={<Link to={`/jobs/${encodeURIComponent(ls.job_id)}`}>Open job</Link>}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatTile
            label="Now"
            icon={<PlayCircleOutlined />}
            color={r.running_job_id ? token.colorPrimary : token.colorTextTertiary}
            value={r.running_job_id ? 'Running' : 'Idle'}
            foot={
              r.running_job_id ? (
                <Link to={`/jobs/${encodeURIComponent(r.running_job_id)}`} className="mono">{shortId(r.running_job_id)}{r.queued ? ` · ${r.queued} queued` : ''}</Link>
              ) : r.queued ? `${r.queued} queued` : 'nothing queued'
            }
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Success rate"
            icon={<CheckCircleOutlined />}
            color={token.colorSuccess}
            value={rate ?? '—'}
            unit={rate === null ? undefined : '%'}
            foot={finished ? `${c.succeeded} of ${finished} finished` : 'no finished jobs'}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Problems"
            icon={<WarningOutlined />}
            color={c.failed + c.timeout ? token.colorError : token.colorTextTertiary}
            value={c.failed + c.timeout}
            foot={`${c.failed} failed · ${c.timeout} timed out`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Last sync"
            icon={<CloudSyncOutlined />}
            color={ls ? (ls.ok ? token.colorSuccess : token.colorError) : token.colorTextTertiary}
            value={<span style={{ fontSize: 20 }}>{ls ? <TimeAgo at={ls.at} /> : 'never'}</span>}
            foot={ls ? <>{ls.branch}{ls.commit && <> @ <span className="mono">{ls.commit.slice(0, 8)}</span></>} · {dur(ls.duration_ms)}</> : r.cloned ? 'workspace cloned' : 'workspace not cloned yet'}
          />
        </Col>
      </Row>

      <Panel style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
          <strong>{total} job{total === 1 ? '' : 's'} in memory</strong>
          <Tooltip title="Workspace directory on the server">
            <span className="muted mono" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FolderOutlined /> {r.workspace_dir}
              <CopyButton text={r.workspace_dir} label="Copy workspace path" />
            </span>
          </Tooltip>
        </div>
        <StatusDistribution counts={c} />
      </Panel>

      <Tabs
        style={{ marginTop: 16 }}
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'jobs', label: 'Jobs', children: <JobsTable fixedRepo={r.id} /> },
          { key: 'audit', label: 'Audit', children: <AuditLog repo={r.id} /> },
        ]}
      />

      <RepoFormModal mode="edit" repo={r} open={dialog === 'edit'} onClose={() => setDialog(null)} />
      {r.auth.kind === 'https' && <TokenModal repo={r} open={dialog === 'token'} onClose={() => setDialog(null)} />}
      <DeleteRepoModal repo={r} open={dialog === 'delete'} onClose={() => setDialog(null)} />
    </>
  );
}
