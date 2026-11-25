import { BranchesOutlined, LoadingOutlined } from '@ant-design/icons';
import { theme, Tooltip } from 'antd';
import { Link } from 'react-router';
import type { RepoStatus } from '../api/types';
import { dur, shortId } from '../lib/format';
import { HealthTag, healthTone, StatusTag } from './StatusTag';
import { CopyButton, StatusDistribution, TimeAgo } from './ui';

export function RepoCard({ repo: r }: { repo: RepoStatus }) {
  const { token } = theme.useToken();
  const ls = r.last_sync;
  const enc = encodeURIComponent;
  return (
    <div className="panel repo-card" style={{ '--accent': healthTone(token, r.health).solid } as React.CSSProperties}>
      <div className="repo-card-head">
        <Link className="repo-card-name" to={`/repos/${enc(r.id)}`}>{r.id}</Link>
        <HealthTag health={r.health} />
        <span style={{ marginLeft: 'auto' }} className="muted nowrap">
          <BranchesOutlined /> {r.default_branch}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: -6 }}>
        <span className="mono muted ellipsis" style={{ fontSize: 12 }} title={r.url_display}>{r.url_display}</span>
        <CopyButton text={r.url_display} label="Copy repo URL" />
      </div>

      {ls && !ls.ok && (
        <div className="codebox err" style={{ maxHeight: 80 }}>
          <strong>Last sync failed:</strong> {ls.error ?? 'unknown error'}
        </div>
      )}

      <dl className="kv">
        <dt>Now</dt>
        <dd>
          {r.running_job_id ? (
            <Link to={`/jobs/${enc(r.running_job_id)}`}>
              <LoadingOutlined style={{ marginRight: 6 }} />
              running <span className="mono">{shortId(r.running_job_id)}</span>
            </Link>
          ) : (
            <span className="muted">idle</span>
          )}
          {r.queued > 0 && <span className="muted"> · {r.queued} queued</span>}
        </dd>
        <dt>Last job</dt>
        <dd>
          {r.last_job ? (
            <Link to={`/jobs/${enc(r.last_job.id)}`} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusTag status={r.last_job.status} hint={false} />
              <span className="muted"><TimeAgo at={r.last_job.created_at} /></span>
            </Link>
          ) : (
            <span className="muted">none yet</span>
          )}
        </dd>
        <dt>Last sync</dt>
        <dd>
          {ls ? (
            <Tooltip title={`${ls.branch}${ls.commit ? ` @ ${ls.commit}` : ''} · took ${dur(ls.duration_ms)}`}>
              <span>
                <TimeAgo at={ls.at} /> <span className="muted">· {ls.branch}{ls.commit && <> @ <span className="mono">{ls.commit.slice(0, 8)}</span></>}</span>
              </span>
            </Tooltip>
          ) : (
            <span className="muted">never{r.cloned ? '' : ' · workspace not cloned yet'}</span>
          )}
        </dd>
      </dl>

      <div style={{ marginTop: 'auto' }}>
        <StatusDistribution counts={r.counts} />
      </div>
    </div>
  );
}
