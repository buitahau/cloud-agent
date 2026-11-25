import { Fragment, useMemo } from 'react';
import {
  ApiOutlined, BranchesOutlined, CalendarOutlined, ClockCircleOutlined, DollarOutlined, FolderOutlined, HourglassOutlined,
  LoadingOutlined, RetweetOutlined, RobotOutlined,
} from '@ant-design/icons';
import { Alert, Col, Row, Skeleton, Tabs, Tooltip, theme } from 'antd';
import { Link, useParams } from 'react-router';
import { useJob } from '../api/queries';
import { TERMINAL, type JobDetail, type JobEvent } from '../api/types';
import { EventStream } from '../components/EventStream';
import { QueryError } from '../components/QueryError';
import { Dot, StatusTag, statusTone } from '../components/StatusTag';
import { CopyButton, PageHeader, Panel, TimeAgo, useNow } from '../components/ui';
import { useJobEvents } from '../hooks/useJobEvents';
import { clock, dur, label, money, shortId, stamp } from '../lib/format';

const enc = encodeURIComponent;

function Fact({ icon, label: l, children, hint }: { icon: React.ReactNode; label: string; children: React.ReactNode; hint?: string }) {
  const el = (
    <div className="fact">
      <div className="fact-label">{icon}{l}</div>
      <div className="fact-value">{children}</div>
    </div>
  );
  return hint ? <Tooltip title={hint}>{el}</Tooltip> : el;
}

/** Proportional timeline of the job's phases (queued → pulling → running → end). */
function Phases({ j, terminal }: { j: JobDetail; terminal: boolean }) {
  const { token } = theme.useToken();
  const now = useNow();
  const h = j.history;
  if (!h.length) return null;
  const segs = h
    .map((p, i) => {
      const next = h[i + 1];
      if (TERMINAL.includes(p.status)) return null;
      const end = next ? Date.parse(next.at) : terminal ? Date.parse(j.finished_at ?? p.at) : now;
      return { status: p.status, at: p.at, ms: Math.max(0, end - Date.parse(p.at)), active: !next && !terminal };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const total = segs.reduce((a, s) => a + s.ms, 0) || 1;
  const last = h[h.length - 1];
  return (
    <div>
      <div className="phases" role="list" aria-label="Job phases">
        {segs.map((s) => (
          <Tooltip key={s.at + s.status} title={`${label(s.status)} at ${clock(s.at)} for ${dur(s.ms)}`}>
            <div role="listitem" className={`phase${s.active ? ' phase-active' : ''}`} style={{ flex: `${Math.max(s.ms, total * 0.12)} 1 0` }}>
              <div className="phase-bar" style={{ background: statusTone(token, s.status).solid }} />
              <div className="phase-label"><b>{label(s.status)}</b><span className="num">{dur(s.ms)}</span></div>
            </div>
          </Tooltip>
        ))}
        {terminal && (
          <Tooltip title={`${label(last.status)} at ${stamp(last.at)}`}>
            <div className="phase" style={{ flex: '0 0 auto', minWidth: 0 }} role="listitem">
              <div className="phase-bar" style={{ width: 6, background: statusTone(token, last.status).solid }} />
              <div className="phase-label"><b>{label(last.status)}</b><span className="num">{clock(last.at)}</span></div>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function modelOf(events: JobEvent[]) {
  const init = events.find((e) => e.type === 'init');
  return init && init.type === 'init' ? init.data.model : null;
}

export function JobPage() {
  const { id = '' } = useParams();
  const { token } = theme.useToken();
  const now = useNow();
  const job = useJob(id);
  const terminal = job.data ? TERMINAL.includes(job.data.status) : false;
  const { events, live } = useJobEvents(id, Boolean(job.data), terminal);
  const model = useMemo(() => modelOf(events), [events]);

  if (job.error) return <QueryError error={job.error} what={`Job "${id}"`} />;
  if (!job.data) {
    return (
      <>
        <Skeleton active title={{ width: 320 }} paragraph={{ rows: 1 }} />
        <Skeleton.Node active style={{ width: '100%', height: 80, marginTop: 16 }} />
        <Skeleton active paragraph={{ rows: 8 }} style={{ marginTop: 16 }} />
      </>
    );
  }
  const j = job.data;
  const failed = j.status === 'failed' || j.status === 'timeout';
  const elapsed = (j.finished_at ? Date.parse(j.finished_at) : now) - Date.parse(j.created_at);
  const queuedMs = j.started_at ? Date.parse(j.started_at) - Date.parse(j.created_at) : null;

  return (
    <>
      <PageHeader
        crumbs={[{ to: '/jobs', label: 'Jobs' }, { to: `/repos/${enc(j.repo_id)}`, label: j.repo_id }, { label: <span className="mono">{shortId(j.id)}</span> }]}
        title={
          <>
            <span>Job <span className="mono">{shortId(j.id)}</span></span>
            <CopyButton text={j.id} label="Copy full job id" />
            <span data-testid="job-status"><StatusTag status={j.status} large /></span>
            {live && (
              <span data-testid="live" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: token.colorPrimaryText }}>
                <Dot color={token.colorPrimary} live /> Live
              </span>
            )}
          </>
        }
        sub={
          <>
            <span><FolderOutlined /><Link to={`/repos/${enc(j.repo_id)}`}>{j.repo_id}</Link></span>
            <span>
              <BranchesOutlined />{j.branch}
              {j.commit && <Tooltip title="Commit the job ran on"><span className="mono">@ {j.commit.slice(0, 10)}</span></Tooltip>}
            </span>
            <span><CalendarOutlined /><TimeAgo at={j.created_at} prefix="created " /></span>
            {j.finished_at && <span><TimeAgo at={j.finished_at} prefix="finished " /></span>}
          </>
        }
      />

      {j.error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={j.status === 'timeout' ? 'Job timed out' : 'Job failed'}
          description={<pre className="textview mono" style={{ maxHeight: 220 }} data-testid="error-text">{j.error}</pre>}
          action={<CopyButton text={j.error} label="Copy error" />}
        />
      )}

      <div className="facts">
        <Fact icon={<ClockCircleOutlined />} label={terminal ? 'Total time' : 'Elapsed'} hint="From creation to finish">
          <span style={{ color: terminal ? undefined : token.colorPrimaryText }}>{dur(elapsed)}</span>
        </Fact>
        <Fact icon={<HourglassOutlined />} label="Waited" hint="Time in queue before a worker picked it up">{dur(queuedMs)}</Fact>
        <Fact icon={<RobotOutlined />} label="Claude time" hint="duration_ms reported by Claude">{dur(j.claude?.duration_ms)}</Fact>
        <Fact icon={<RetweetOutlined />} label="Turns">{j.claude?.num_turns ?? '—'}</Fact>
        <Fact icon={<DollarOutlined />} label="Cost">{money(j.claude?.total_cost_usd)}</Fact>
        <Fact icon={<ApiOutlined />} label="Model"><span className="mono" style={{ fontSize: 13 }}>{model ?? '—'}</span></Fact>
      </div>

      <Panel style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <strong>Timeline</strong>
          <span className="muted">{j.claude?.subtype ? <>outcome <span className="mono">{j.claude.subtype}</span></> : null}</span>
        </div>
        <Phases j={j} terminal={terminal} />
      </Panel>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Panel title="Prompt" extra={<CopyButton text={j.prompt} label="Copy prompt" />} style={{ height: '100%' }} testId="prompt">
            <pre className="textview" data-testid="prompt-text">{j.prompt}</pre>
          </Panel>
        </Col>
        <Col xs={24} lg={12}>
          <Panel
            title="Result"
            extra={j.result ? <CopyButton text={j.result} label="Copy result" /> : null}
            style={{ height: '100%' }}
            testId="result"
          >
            {j.result ? (
              <pre className="textview" data-testid="result-text">{j.result}</pre>
            ) : !terminal ? (
              <div className="muted" data-testid="result-text" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <LoadingOutlined /> Waiting for Claude to finish…
              </div>
            ) : (
              <div className="muted" data-testid="result-text">{failed ? 'No result. See the error above.' : 'No result text.'}</div>
            )}
          </Panel>
        </Col>
      </Row>

      <section className="panel" style={{ marginTop: 16 }}>
        <Tabs
          tabBarStyle={{ margin: 0, padding: '0 16px' }}
          items={[
            {
              key: 'events',
              label: (
                <span data-testid="events-tab" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  Activity <span className="muted num" data-testid="events-count">{events.length}</span>
                  {live && <Dot color={token.colorPrimary} live />}
                </span>
              ),
              children: <EventStream events={events} live={live} />,
            },
            {
              key: 'log',
              label: <span>Log <span className="muted num">{j.log.length}</span></span>,
              children: (
                <div style={{ padding: 12 }}>
                  {j.log.length === 0 ? (
                    <div className="empty-note">No log lines.</div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                        <CopyButton text={j.log.join('\n')} label="Copy log" />
                      </div>
                      <div className="logview mono">
                        {j.log.map((line, i) => (
                          <div key={i}><span className="ln">{i + 1}</span><span>{line}</span></div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'details',
              label: 'Details',
              children: (
                <dl className="kv" style={{ padding: 16 }}>
                  <dt>Job id</dt><dd className="mono">{j.id}</dd>
                  <dt>Session</dt><dd className="mono">{j.claude?.session_id ?? '—'}</dd>
                  <dt>Commit</dt><dd className="mono">{j.commit ?? '—'}</dd>
                  <dt>Created</dt><dd>{stamp(j.created_at)}</dd>
                  <dt>Started</dt><dd>{stamp(j.started_at)}</dd>
                  <dt>Finished</dt><dd>{stamp(j.finished_at)}</dd>
                  <dt>Events buffered</dt><dd className="num">{j.events_buffered}</dd>
                  {j.history.map((h, i) => (
                    <Fragment key={i}><dt>→ {label(h.status)}</dt><dd>{stamp(h.at)}</dd></Fragment>
                  ))}
                </dl>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
