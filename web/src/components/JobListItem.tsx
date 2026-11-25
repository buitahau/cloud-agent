import { Link } from 'react-router';
import type { JobSummary } from '../api/types';
import { dur, shortId } from '../lib/format';
import { StatusTag } from './StatusTag';
import { TimeAgo, useNow } from './ui';

/** One compact, fully clickable job row: status · prompt (or error) · id/repo · time. */
export function JobListItem({ job: j, showRepo = true }: { job: JobSummary; showRepo?: boolean }) {
  const now = useNow();
  const active = !j.finished_at;
  const elapsed = active && j.started_at ? now - Date.parse(j.started_at) : null;
  return (
    <Link className="list-row" to={`/jobs/${encodeURIComponent(j.id)}`}>
      <StatusTag status={j.status} hint={false} />
      <div className="grow">
        <div className="ellipsis" style={{ color: 'var(--c-text)', fontWeight: 500 }} title={j.prompt_preview}>{j.prompt_preview || '(empty prompt)'}</div>
        {j.error_preview ? (
          <div className="ellipsis" style={{ color: 'var(--c-error)', fontSize: 12 }} title={j.error_preview}>{j.error_preview}</div>
        ) : (
          <div className="job-cell-meta">
            <span className="mono">{shortId(j.id)}</span>
            {showRepo && <span>{j.repo_id}</span>}
            <span>{j.branch}</span>
          </div>
        )}
      </div>
      <div className="muted nowrap" style={{ fontSize: 12, textAlign: 'right' }}>
        {elapsed !== null ? <span className="num">{dur(elapsed)}</span> : <TimeAgo at={j.finished_at ?? j.created_at} />}
      </div>
    </Link>
  );
}
