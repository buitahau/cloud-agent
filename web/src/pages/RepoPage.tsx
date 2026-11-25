import { BranchesOutlined, CheckCircleOutlined, CloudSyncOutlined, FolderOutlined, PlayCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, Col, Row, Skeleton, theme, Tooltip } from 'antd';
import { Link, useParams } from 'react-router';
import { useRepo } from '../api/queries';
import { JobsTable } from '../components/JobsTable';
import { QueryError } from '../components/QueryError';
import { HealthTag } from '../components/StatusTag';
import { CopyButton, PageHeader, Panel, StatTile, StatusDistribution, TimeAgo } from '../components/ui';
import { dur, shortId } from '../lib/format';

export function RepoPage() {
  const { id = '' } = useParams();
  const { token } = theme.useToken();
  const repo = useRepo(id);

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
        title={<>{r.id} <HealthTag health={r.health} large /></>}
        sub={
          <>
            <span className="mono">{r.url_display}<CopyButton text={r.url_display} label="Copy repo URL" /></span>
            <span><BranchesOutlined /> default {r.default_branch}</span>
          </>
        }
      />

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

      <h2 className="section-title">Jobs</h2>
      <JobsTable fixedRepo={r.id} />
    </>
  );
}
