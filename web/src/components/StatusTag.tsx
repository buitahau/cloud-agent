import { Tag } from 'antd';
import type { JobStatus, RepoHealth } from '../api/types';
import { label } from '../lib/format';

const JOB_COLOR: Record<JobStatus, string> = {
  queued: 'default',
  pulling: 'cyan',
  running: 'processing',
  succeeded: 'success',
  failed: 'error',
  timeout: 'warning',
};

const HEALTH_COLOR: Record<RepoHealth, string> = {
  ok: 'success',
  syncing: 'processing',
  sync_error: 'error',
  never_synced: 'default',
};

export function StatusTag({ status, children }: { status: JobStatus; children?: React.ReactNode }) {
  return <Tag color={JOB_COLOR[status] ?? 'default'}>{children ?? label(status)}</Tag>;
}

export function HealthTag({ health }: { health: RepoHealth }) {
  return <Tag color={HEALTH_COLOR[health] ?? 'default'}>{label(health)}</Tag>;
}
