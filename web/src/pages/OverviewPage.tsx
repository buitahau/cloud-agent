import { Alert, Card, Col, Empty, Row, Skeleton, Statistic, Typography } from 'antd';
import { useRepos, useSummary } from '../api/queries';
import { RepoCard } from '../components/RepoCard';
import { QueryError } from '../components/QueryError';
import { upt } from '../lib/format';

export function OverviewPage() {
  const summary = useSummary();
  const repos = useRepos();

  if (summary.error) return <QueryError error={summary.error} what="summary" />;
  if (!summary.data) return <Skeleton active />;
  const s = summary.data;

  const stats: [string, React.ReactNode][] = [
    ['Running', `${s.running.length} / ${s.max_concurrent}`],
    ['Queued', s.queued],
    ['Succeeded (24h)', s.last_24h.succeeded],
    ['Failed (24h)', s.last_24h.failed],
    ['Timed out (24h)', s.last_24h.timeout],
  ];

  return (
    <>
      <Typography.Title level={2}>Overview</Typography.Title>
      <Typography.Paragraph type="secondary">
        Up {upt(s.uptime_s)} · {s.repos} repo{s.repos === 1 ? '' : 's'} · job history{' '}
        {s.persistence ? 'saved to disk' : 'in memory only'}
      </Typography.Paragraph>
      {!s.persistence && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="Job history is in memory only and will be lost on restart (set JOBS_FILE to persist)." />
      )}
      <Row gutter={[16, 16]}>
        {stats.map(([k, v]) => (
          <Col key={k} flex="1 1 180px">
            <Card size="small">
              <Statistic title={k} value={v as string | number} />
            </Card>
          </Col>
        ))}
      </Row>

      <Typography.Title level={3} style={{ marginTop: 32 }}>Repos</Typography.Title>
      {repos.error ? (
        <QueryError error={repos.error} what="repos" />
      ) : !repos.data ? (
        <Skeleton active />
      ) : repos.data.length === 0 ? (
        <Empty description="No repos configured" />
      ) : (
        <Row gutter={[16, 16]}>
          {repos.data.map((r) => (
            <Col key={r.id} xs={24} md={12} xl={8}>
              <RepoCard repo={r} />
            </Col>
          ))}
        </Row>
      )}
    </>
  );
}
