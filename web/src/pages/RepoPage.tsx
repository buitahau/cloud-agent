import { Breadcrumb, Card, Col, Descriptions, Row, Skeleton, Space, Typography } from 'antd';
import { Link, useParams } from 'react-router';
import { useRepo } from '../api/queries';
import { JobsTable } from '../components/JobsTable';
import { QueryError } from '../components/QueryError';
import { RepoCard } from '../components/RepoCard';
import { HealthTag } from '../components/StatusTag';

export function RepoPage() {
  const { id = '' } = useParams();
  const repo = useRepo(id);

  if (repo.error) return <QueryError error={repo.error} what={`Repo "${id}"`} />;
  if (!repo.data) return <Skeleton active />;
  const r = repo.data;
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <Breadcrumb items={[{ title: <Link to="/">Overview</Link> }, { title: r.id }]} />
      <Space align="center" style={{ margin: '12px 0' }}>
        <Typography.Title level={2} style={{ margin: 0 }}>{r.id}</Typography.Title>
        <HealthTag health={r.health} />
      </Space>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <RepoCard repo={r} />
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Details" style={{ height: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="Workspace dir">
                <Typography.Text code copyable>{r.workspace_dir}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="Default branch">{r.default_branch}</Descriptions.Item>
              <Descriptions.Item label="Jobs in memory">{total}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
      <Typography.Title level={3} style={{ marginTop: 32 }}>Jobs</Typography.Title>
      <JobsTable fixedRepo={r.id} />
    </>
  );
}
