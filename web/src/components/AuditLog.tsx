import { Button, Empty, Skeleton, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { useAuditInfinite } from '../api/queries';
import type { AuditEntry } from '../api/types';
import { auditLines } from '../lib/format';
import { QueryError } from './QueryError';
import { TimeAgo } from './ui';

const ACTION_COLOR: Record<string, string> = {
  'repo.create': 'green', 'repo.update': 'blue', 'repo.enable': 'cyan', 'repo.disable': 'orange',
  'repo.delete': 'red', 'token.set': 'purple', 'key.rotate': 'geekblue', import: 'default',
};

/** Paged audit log for one repo. Secrets never reach it: the server stores only "set …a1b2" / "dropped". */
export function AuditLog({ repo }: { repo: string }) {
  const q = useAuditInfinite(repo);
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const columns: TableColumnsType<AuditEntry> = [
    { title: 'When', dataIndex: 'at', width: 120, render: (at: string) => <TimeAgo at={at} /> },
    { title: 'Action', dataIndex: 'action', width: 130, render: (a: string) => <Tag bordered={false} color={ACTION_COLOR[a] ?? 'default'} className="mono">{a}</Tag> },
    {
      title: 'Details', dataIndex: 'details', render: (d: AuditEntry['details']) => {
        const lines = auditLines(d);
        return lines.length
          ? <div className="mono" style={{ fontSize: 12 }}>{lines.map((l, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{l}</div>)}</div>
          : <span className="muted">—</span>;
      },
    },
    { title: 'Actor', dataIndex: 'actor', width: 110, responsive: ['md'] },
    { title: 'IP', dataIndex: 'ip', width: 140, responsive: ['lg'], render: (ip: string | null) => <span className="mono muted">{ip ?? '—'}</span> },
  ];
  if (q.error) return <QueryError error={q.error} what="audit log" />;
  if (q.isLoading) return <div className="panel panel-pad"><Skeleton active paragraph={{ rows: 4 }} /></div>;
  return (
    <>
      <Table<AuditEntry> className="jobs-table audit-table" rowKey="id" size="small" tableLayout="fixed"
        columns={columns} dataSource={rows} pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes recorded yet" /> }} />
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
          <Button onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load older</Button>
        </div>
      )}
    </>
  );
}
