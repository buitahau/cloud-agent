import { Card, Descriptions, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { JOB_STATUSES, type RepoStatus } from '../api/types';
import { ago, dur, shortId } from '../lib/format';
import { HealthTag, StatusTag } from './StatusTag';

export function RepoCard({ repo: r }: { repo: RepoStatus }) {
  const ls = r.last_sync;
  const counts = JOB_STATUSES.filter((s) => r.counts[s]);
  return (
    <Card
      size="small"
      title={<Link to={`/repos/${encodeURIComponent(r.id)}`}>{r.id}</Link>}
      extra={
        <Space size={4}>
          <Typography.Text type="secondary">{r.default_branch}</Typography.Text>
          <HealthTag health={r.health} />
        </Space>
      }
      style={{ height: '100%' }}
    >
      <Typography.Text code copyable style={{ wordBreak: 'break-all' }}>
        {r.url_display}
      </Typography.Text>
      <Descriptions size="small" column={1} style={{ marginTop: 12 }}>
        <Descriptions.Item label="Last sync">
          {ls ? `${ago(ls.at)} · ${ls.branch}${ls.commit ? ` @ ${ls.commit}` : ''} · ${dur(ls.duration_ms)}` : 'never'}
        </Descriptions.Item>
        {ls && !ls.ok && (
          <Descriptions.Item label="Sync error">
            <Typography.Text type="danger">{ls.error ?? 'unknown'}</Typography.Text>
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Workspace">{r.cloned ? 'cloned' : 'not cloned yet'}</Descriptions.Item>
        <Descriptions.Item label="Now">
          {r.running_job_id ? (
            <Link to={`/jobs/${encodeURIComponent(r.running_job_id)}`}>running {shortId(r.running_job_id)}</Link>
          ) : (
            'idle'
          )}
          {r.queued ? ` · ${r.queued} queued` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="Last job">
          {r.last_job ? (
            <Space size={6} wrap>
              <Link className="mono" to={`/jobs/${encodeURIComponent(r.last_job.id)}`}>{shortId(r.last_job.id)}</Link>
              <StatusTag status={r.last_job.status} />
              <Typography.Text type="secondary">{ago(r.last_job.created_at)}</Typography.Text>
            </Space>
          ) : (
            '—'
          )}
        </Descriptions.Item>
      </Descriptions>
      {counts.length > 0 && (
        <Space size={4} wrap style={{ marginTop: 8 }}>
          {counts.map((s) => (
            <StatusTag key={s} status={s}>{`${r.counts[s]} ${s}`}</StatusTag>
          ))}
        </Space>
      )}
      {counts.length === 0 && <Tag>no jobs</Tag>}
    </Card>
  );
}
