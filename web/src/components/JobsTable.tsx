import { Button, Flex, Select, Table, Tooltip, Typography, type TableColumnsType } from 'antd';
import { Link, useSearchParams } from 'react-router';
import { useJobsInfinite, useRepos } from '../api/queries';
import { JOB_STATUSES, type JobStatus, type JobSummary } from '../api/types';
import { ago, dur, label, money, shortId } from '../lib/format';
import { QueryError } from './QueryError';
import { StatusTag } from './StatusTag';

const enc = encodeURIComponent;

/** Filterable, cursor-paged job table. Filters live in the URL (?repo=&status=a,b) so reload/back work. */
export function JobsTable({ fixedRepo }: { fixedRepo?: string }) {
  const [params, setParams] = useSearchParams();
  const repo = fixedRepo ?? params.get('repo') ?? '';
  const statuses = (params.get('status') ?? '').split(',').filter((s): s is JobStatus => (JOB_STATUSES as readonly string[]).includes(s));
  const repos = useRepos(false);
  const jobs = useJobsInfinite(repo, statuses);

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

  const columns: TableColumnsType<JobSummary> = [
    {
      title: 'Job',
      dataIndex: 'id',
      render: (id: string) => <Link className="mono" to={`/jobs/${enc(id)}`}>{shortId(id)}</Link>,
    },
    { title: 'Status', dataIndex: 'status', render: (s: JobStatus) => <StatusTag status={s} /> },
    ...(fixedRepo
      ? []
      : [{ title: 'Repo', dataIndex: 'repo_id', render: (r: string) => <Link to={`/repos/${enc(r)}`}>{r}</Link> }]),
    { title: 'Branch', dataIndex: 'branch' },
    {
      title: 'Commit',
      dataIndex: 'commit',
      render: (c: string | null) => (c ? <Typography.Text code>{c}</Typography.Text> : '—'),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (at: string) => <Tooltip title={at}>{ago(at)}</Tooltip>,
    },
    { title: 'Queue', dataIndex: 'queue_ms', align: 'right', render: dur },
    { title: 'Sync', dataIndex: 'sync_ms', align: 'right', render: dur },
    { title: 'Run', dataIndex: 'run_ms', align: 'right', render: dur },
    { title: 'Cost', dataIndex: 'cost_usd', align: 'right', render: money },
    { title: 'Turns', dataIndex: 'num_turns', align: 'right', render: (n: number | null) => n ?? '—' },
    {
      title: 'Prompt',
      dataIndex: 'prompt_preview',
      width: 320,
      render: (p: string, j) => (
        <Typography.Text
          type={j.error_preview ? 'danger' : undefined}
          ellipsis={{ tooltip: j.error_preview ?? p }}
          style={{ maxWidth: 320 }}
        >
          {p}
        </Typography.Text>
      ),
    },
  ];

  const rows = jobs.data?.pages.flatMap((p) => p.jobs) ?? [];

  return (
    <>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        {!fixedRepo && (
          <Select
            aria-label="Repo"
            allowClear
            placeholder="All repos"
            style={{ minWidth: 180 }}
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
          style={{ minWidth: 240 }}
          value={statuses}
          options={JOB_STATUSES.map((s) => ({ value: s, label: label(s) }))}
          onChange={(v: string[]) => setFilter('status', v.join(','))}
        />
      </Flex>
      {jobs.error ? (
        <QueryError error={jobs.error} what="jobs" />
      ) : (
        <Table<JobSummary>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={jobs.isLoading}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No jobs yet.' }}
        />
      )}
      {jobs.hasNextPage && (
        <Flex justify="center" style={{ marginTop: 12 }}>
          <Button onClick={() => jobs.fetchNextPage()} loading={jobs.isFetchingNextPage}>
            Load more
          </Button>
        </Flex>
      )}
    </>
  );
}
