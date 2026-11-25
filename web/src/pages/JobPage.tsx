import { Alert, Badge, Breadcrumb, Card, Col, Collapse, Descriptions, Row, Skeleton, Space, Steps, Typography } from 'antd';
import { Link, useParams } from 'react-router';
import { useJob } from '../api/queries';
import { TERMINAL } from '../api/types';
import { EventStream } from '../components/EventStream';
import { QueryError } from '../components/QueryError';
import { StatusTag } from '../components/StatusTag';
import { useJobEvents } from '../hooks/useJobEvents';
import { ago, dur, money } from '../lib/format';

const enc = encodeURIComponent;

export function JobPage() {
  const { id = '' } = useParams();
  const job = useJob(id);
  const terminal = job.data ? TERMINAL.includes(job.data.status) : false;
  const { events, live } = useJobEvents(id, Boolean(job.data), terminal);

  if (job.error) return <QueryError error={job.error} what={`Job "${id}"`} />;
  if (!job.data) return <Skeleton active />;
  const j = job.data;
  const failed = j.status === 'failed' || j.status === 'timeout';

  return (
    <>
      <Breadcrumb
        items={[
          { title: <Link to="/">Overview</Link> },
          { title: <Link to={`/repos/${enc(j.repo_id)}`}>{j.repo_id}</Link> },
          { title: <span className="mono">{j.id}</span> },
        ]}
      />
      <Space align="center" wrap style={{ margin: '12px 0' }}>
        <Typography.Title level={3} className="mono" style={{ margin: 0 }} copyable={{ text: j.id }}>
          {j.id}
        </Typography.Title>
        <StatusTag status={j.status} />
      </Space>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions size="small" column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="Repo"><Link to={`/repos/${enc(j.repo_id)}`}>{j.repo_id}</Link></Descriptions.Item>
          <Descriptions.Item label="Branch">
            {j.branch}
            {j.commit && <Typography.Text code style={{ marginLeft: 6 }}>{j.commit}</Typography.Text>}
          </Descriptions.Item>
          <Descriptions.Item label="Created"><span title={j.created_at}>{ago(j.created_at)}</span></Descriptions.Item>
          <Descriptions.Item label="Finished"><span title={j.finished_at ?? ''}>{ago(j.finished_at)}</span></Descriptions.Item>
          <Descriptions.Item label="Cost">{money(j.claude?.total_cost_usd)}</Descriptions.Item>
          <Descriptions.Item label="Turns">{j.claude?.num_turns ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Claude time">{dur(j.claude?.duration_ms)}</Descriptions.Item>
          <Descriptions.Item label="Outcome">{j.claude?.subtype ?? '—'}</Descriptions.Item>
        </Descriptions>
        <Steps
          size="small"
          style={{ marginTop: 16 }}
          current={j.history.length - 1}
          status={failed ? 'error' : terminal ? 'finish' : 'process'}
          items={j.history.map((h, i) => {
            const next = j.history[i + 1];
            return {
              title: h.status,
              content: (
                <span title={h.at}>
                  {new Date(h.at).toLocaleTimeString()}
                  {next ? ` → ${dur(Date.parse(next.at) - Date.parse(h.at))}` : ''}
                </span>
              ),
            };
          })}
        />
      </Card>

      {j.error && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} title="Error" description={<pre className="box">{j.error}</pre>} />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Prompt" style={{ height: '100%' }}>
            <pre className="box mono">{j.prompt}</pre>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Result" style={{ height: '100%' }}>
            <pre className="box mono">{j.result ?? (terminal ? '—' : '(not finished)')}</pre>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={`Events (${events.length})`}
        extra={live ? <Badge status="processing" text="live" /> : null}
        style={{ marginTop: 16 }}
      >
        <EventStream events={events} />
      </Card>

      <Collapse
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'log',
            label: `Log (${j.log.length} lines)`,
            children: <pre className="box mono">{j.log.join('\n') || '—'}</pre>,
          },
        ]}
      />
    </>
  );
}
