import {
  CheckCircleOutlined, ClockCircleOutlined, DatabaseOutlined, PlayCircleOutlined, PlusOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Col, Progress, Row, Skeleton, theme } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { useRecentJobs, useRepos, useSummary } from '../api/queries';
import { JobListItem } from '../components/JobListItem';
import { QueryError } from '../components/QueryError';
import { RepoCard } from '../components/RepoCard';
import { RepoFormModal } from '../components/RepoForm';
import { PageHeader, Panel, StatTile, StatusDistribution } from '../components/ui';
import { plural, upt } from '../lib/format';

const ACTIVE = ['queued', 'pulling', 'running'];
const PROBLEMS = ['failed', 'timeout'];

function JobsPanel({ title, statuses, empty, to, testId }: { title: React.ReactNode; statuses: string[]; empty: string; to: string; testId: string }) {
  const q = useRecentJobs(statuses, 6);
  const jobs = q.data?.jobs ?? [];
  return (
    <Panel title={title} extra={<Link to={to}>View all</Link>} pad={false} style={{ height: '100%' }} testId={testId}>
      {q.error ? (
        <div style={{ padding: 16 }}><QueryError error={q.error} what="jobs" /></div>
      ) : !q.data ? (
        <div style={{ padding: 16 }}><Skeleton active paragraph={{ rows: 3 }} title={false} /></div>
      ) : jobs.length === 0 ? (
        <div className="empty-note">{empty}</div>
      ) : (
        jobs.map((j) => <JobListItem key={j.id} job={j} />)
      )}
    </Panel>
  );
}

export function OverviewPage() {
  const { token } = theme.useToken();
  const summary = useSummary();
  const repos = useRepos();
  const [adding, setAdding] = useState(false);

  if (summary.error) return <QueryError error={summary.error} what="summary" />;
  if (!summary.data) {
    return (
      <>
        <Skeleton active title={{ width: 200 }} paragraph={{ rows: 1 }} />
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          {[0, 1, 2, 3].map((i) => <Col key={i} xs={12} lg={6}><div className="stat"><Skeleton active paragraph={{ rows: 1 }} /></div></Col>)}
        </Row>
      </>
    );
  }
  const s = summary.data;
  const d = s.last_24h;
  const finished = d.succeeded + d.failed + d.timeout;
  const problems = d.failed + d.timeout;
  const rate = finished ? Math.round((d.succeeded / finished) * 100) : null;
  const running = s.running.length;
  const util = s.max_concurrent ? Math.round((running / s.max_concurrent) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        sub={
          <>
            <span><ClockCircleOutlined /> up {upt(s.uptime_s)}</span>
            <span>{s.repos} {s.repos === 1 ? 'repository' : 'repositories'}</span>
            {s.persistence && <span><DatabaseOutlined /> history saved to disk</span>}
          </>
        }
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add repo</Button>}
      />
      {!s.persistence && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          title={<>Job history is in memory only and will be lost on restart. Set <code>JOBS_FILE</code> to persist it.</>}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatTile
            testId="stat-running"
            label="Running"
            icon={<PlayCircleOutlined />}
            color={token.colorPrimary}
            value={running}
            unit={`/ ${s.max_concurrent} slots`}
            to="/jobs?status=pulling,running"
            foot={<Progress percent={util} showInfo={false} size="small" strokeColor={token.colorPrimary} aria-label={`${util}% of worker slots busy`} />}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Queued"
            icon={<ClockCircleOutlined />}
            color={s.queued ? token.colorWarning : token.colorTextTertiary}
            value={s.queued}
            to="/jobs?status=queued"
            foot={s.queued ? 'waiting for a free slot' : 'nothing waiting'}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Success rate · 24h"
            icon={<CheckCircleOutlined />}
            color={token.colorSuccess}
            value={rate === null ? '—' : rate}
            unit={rate === null ? undefined : '%'}
            to="/jobs?status=succeeded"
            foot={finished ? `${d.succeeded} of ${finished} finished jobs` : 'no finished jobs yet'}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile
            label="Problems · 24h"
            icon={<WarningOutlined />}
            color={problems ? token.colorError : token.colorTextTertiary}
            value={problems}
            to="/jobs?status=failed,timeout"
            foot={problems ? `${d.failed} failed · ${d.timeout} timed out` : 'all clear'}
          />
        </Col>
      </Row>

      <Panel style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
          <strong>Last 24 hours</strong>
          <span className="muted">{plural(Object.values(d).reduce((a, b) => a + b, 0), 'job')}</span>
        </div>
        <StatusDistribution counts={d} />
      </Panel>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <JobsPanel
            testId="active-jobs"
            title={<><PlayCircleOutlined style={{ color: token.colorPrimary }} /> Active now</>}
            statuses={ACTIVE}
            empty="No jobs running or queued."
            to={`/jobs?status=${ACTIVE.join(',')}`}
          />
        </Col>
        <Col xs={24} xl={12}>
          <JobsPanel
            testId="recent-problems"
            title={<><WarningOutlined style={{ color: token.colorError }} /> Recent failures</>}
            statuses={PROBLEMS}
            empty="No failed or timed-out jobs."
            to={`/jobs?status=${PROBLEMS.join(',')}`}
          />
        </Col>
      </Row>

      <h2 className="section-title">
        Repositories <span className="count">{repos.data?.length ?? ''}</span>
      </h2>
      {repos.error ? (
        <QueryError error={repos.error} what="repos" />
      ) : !repos.data ? (
        <Skeleton active />
      ) : repos.data.length === 0 ? (
        <Panel>
          <div className="empty-note">
            No repositories yet.
            <div style={{ marginTop: 12 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add your first repo</Button>
            </div>
          </div>
        </Panel>
      ) : (
        <Row gutter={[16, 16]}>
          {repos.data.map((r) => (
            <Col key={r.id} xs={24} md={12} xxl={8}>
              <RepoCard repo={r} />
            </Col>
          ))}
        </Row>
      )}
      <RepoFormModal mode="create" open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
