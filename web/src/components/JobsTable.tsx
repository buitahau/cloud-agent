import { BranchesOutlined, ClearOutlined, FilterOutlined } from '@ant-design/icons';
import { Button, Empty, Select, Skeleton, Table, Tooltip, type TableColumnsType } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useJobsInfinite, useRepos } from '../api/queries';
import { JOB_STATUSES, type JobStatus, type JobSummary } from '../api/types';
import { dur, label, money, shortId } from '../lib/format';
import { QueryError } from './QueryError';
import { StatusTag } from './StatusTag';
import { TimeAgo, useNow } from './ui';

const enc = encodeURIComponent;

function Duration({ j }: { j: JobSummary }) {
  const now = useNow();
  if (!j.finished_at) {
    const since = j.started_at ?? j.created_at;
    return (
      <Tooltip title={j.started_at ? 'Elapsed since start' : 'Waiting in queue'}>
        <span className="num" style={{ color: 'var(--c-primary)' }}>{dur(now - Date.parse(since))}</span>
      </Tooltip>
    );
  }
  const total = (j.queue_ms ?? 0) + (j.sync_ms ?? 0) + (j.run_ms ?? 0);
  return (
    <Tooltip
      title={
        <div className="num">
          <div>Queue: {dur(j.queue_ms)}</div>
          <div>Sync: {dur(j.sync_ms)}</div>
          <div>Run: {dur(j.run_ms)}</div>
        </div>
      }
    >
      <span className="num">{dur(total)}</span>
    </Tooltip>
  );
}

/** Filterable, cursor-paged job table. Filters live in the URL (?repo=&status=a,b) so reload/back work. */
export function JobsTable({ fixedRepo }: { fixedRepo?: string }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const repo = fixedRepo ?? params.get('repo') ?? '';
  const statuses = (params.get('status') ?? '').split(',').filter((s): s is JobStatus => (JOB_STATUSES as readonly string[]).includes(s));
  const repos = useRepos(false);
  const jobs = useJobsInfinite(repo, statuses);
  const filtered = Boolean((!fixedRepo && repo) || statuses.length);

  const setFilter = (key: string, value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const clear = () => setParams(new URLSearchParams(), { replace: true });

  const columns: TableColumnsType<JobSummary> = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 128,
      render: (s: JobStatus) => <StatusTag status={s} />,
    },
    {
      title: 'Job',
      dataIndex: 'prompt_preview',
      render: (p: string, j) => (
        <div style={{ minWidth: 0 }}>
          <Link to={`/jobs/${enc(j.id)}`} className="job-cell-title ellipsis" title={p}>
            {p || <span className="muted">(empty prompt)</span>}
          </Link>
          {j.error_preview && <span className="job-cell-err ellipsis" title={j.error_preview}>{j.error_preview}</span>}
          <div className="job-cell-meta">
            <Tooltip title={j.id}><span className="mono">{shortId(j.id)}</span></Tooltip>
            {!fixedRepo && (
              <Link to={`/repos/${enc(j.repo_id)}`} className="idlink" onClick={(e) => e.stopPropagation()}>{j.repo_id}</Link>
            )}
            <span className="nowrap">
              <BranchesOutlined /> {j.branch}
              {j.commit && <span className="mono"> @ {j.commit.slice(0, 8)}</span>}
            </span>
          </div>
        </div>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 110,
      responsive: ['sm'],
      render: (at: string) => <span className="muted"><TimeAgo at={at} /></span>,
    },
    { title: 'Duration', key: 'dur', width: 100, align: 'right', responsive: ['md'], render: (_: unknown, j) => <Duration j={j} /> },
    { title: 'Cost', dataIndex: 'cost_usd', width: 90, align: 'right', responsive: ['lg'], render: (v: number | null) => <span className="num">{money(v)}</span> },
    { title: 'Turns', dataIndex: 'num_turns', width: 70, align: 'right', responsive: ['lg'], render: (n: number | null) => <span className="num">{n ?? '—'}</span> },
  ];

  const rows = jobs.data?.pages.flatMap((p) => p.jobs) ?? [];

  return (
    <>
      <div className="toolbar" role="search">
        <FilterOutlined className="muted" aria-hidden />
        {!fixedRepo && (
          <Select
            aria-label="Repo"
            allowClear
            placeholder="All repositories"
            style={{ minWidth: 170 }}
            value={repo || undefined}
            loading={repos.isLoading}
            options={(repos.data ?? []).map((r) => ({ value: r.id, label: r.id }))}
            onChange={(v?: string) => setFilter('repo', v ?? '')}
          />
        )}
        <Select
          aria-label="Status"
          mode="multiple"
          allowClear
          placeholder="Any status"
          style={{ minWidth: 220, maxWidth: '100%' }}
          value={statuses}
          maxTagCount="responsive"
          options={JOB_STATUSES.map((s) => ({ value: s, label: label(s) }))}
          onChange={(v: string[]) => setFilter('status', v.join(','))}
        />
        {filtered && (
          <Button type="text" icon={<ClearOutlined />} onClick={clear}>
            Clear
          </Button>
        )}
        <span className="spacer" />
        {jobs.data && (
          <span className="muted" style={{ fontSize: 12 }} aria-live="polite">
            {rows.length} job{rows.length === 1 ? '' : 's'}{jobs.hasNextPage ? ' · more available' : ''}
          </span>
        )}
      </div>
      {jobs.error ? (
        <QueryError error={jobs.error} what="jobs" />
      ) : jobs.isLoading ? (
        <div className="panel panel-pad"><Skeleton active paragraph={{ rows: 8 }} /></div>
      ) : (
        <Table<JobSummary>
          className="jobs-table"
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={jobs.isFetching && jobs.isPlaceholderData}
          pagination={false}
          tableLayout="fixed"
          onRow={(j) => ({
            onClick: (e) => {
              if ((e.target as HTMLElement).closest('a,button')) return;
              if (window.getSelection()?.toString()) return; // let people select text without navigating
              nav(`/jobs/${enc(j.id)}`);
            },
          })}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={filtered ? 'No jobs match these filters' : 'No jobs yet'}
              >
                {filtered && <Button onClick={clear}>Clear filters</Button>}
              </Empty>
            ),
          }}
        />
      )}
      {jobs.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
          <Button onClick={() => jobs.fetchNextPage()} loading={jobs.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
