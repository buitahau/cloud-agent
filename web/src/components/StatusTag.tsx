import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloudSyncOutlined,
  ExclamationCircleFilled,
  FieldTimeOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { theme, Tooltip } from 'antd';
import type { GlobalToken } from 'antd';
import type { JobStatus, RepoHealth } from '../api/types';
import { label } from '../lib/format';

type Tone = { fg: string; solid: string };

/** Text colour (readable on the surface) and solid colour (bars/dots) for each job status. */
export function statusTone(t: GlobalToken, s: JobStatus): Tone {
  switch (s) {
    case 'queued': return { fg: t.colorTextSecondary, solid: t.colorTextQuaternary };
    case 'pulling': return { fg: t.colorInfoText, solid: t.colorInfo };
    case 'running': return { fg: t.colorPrimaryText, solid: t.colorPrimary };
    case 'succeeded': return { fg: t.colorSuccessText, solid: t.colorSuccess };
    case 'failed': return { fg: t.colorErrorText, solid: t.colorError };
    case 'timeout': return { fg: t.colorWarningText, solid: t.colorWarning };
    default: return { fg: t.colorTextSecondary, solid: t.colorTextQuaternary };
  }
}

export function healthTone(t: GlobalToken, h: RepoHealth): Tone {
  switch (h) {
    case 'ok': return { fg: t.colorSuccessText, solid: t.colorSuccess };
    case 'syncing': return { fg: t.colorPrimaryText, solid: t.colorPrimary };
    case 'sync_error': return { fg: t.colorErrorText, solid: t.colorError };
    default: return { fg: t.colorTextSecondary, solid: t.colorTextQuaternary };
  }
}

const STATUS_ICON: Record<JobStatus, React.ReactNode> = {
  queued: <ClockCircleOutlined />,
  pulling: <CloudSyncOutlined />,
  running: <LoadingOutlined />,
  succeeded: <CheckCircleFilled />,
  failed: <CloseCircleFilled />,
  timeout: <FieldTimeOutlined />,
};

const STATUS_HINT: Record<JobStatus, string> = {
  queued: 'Waiting for a free worker slot',
  pulling: 'Syncing the repo workspace',
  running: 'Claude is working on the prompt',
  succeeded: 'Finished successfully',
  failed: 'Finished with an error',
  timeout: 'Stopped after hitting the time limit',
};

const HEALTH_ICON: Record<RepoHealth, React.ReactNode> = {
  ok: <CheckCircleFilled />,
  syncing: <SyncOutlined spin />,
  sync_error: <ExclamationCircleFilled />,
  never_synced: <MinusCircleOutlined />,
};

const HEALTH_TEXT: Record<RepoHealth, string> = { ok: 'healthy', syncing: 'syncing', sync_error: 'sync error', never_synced: 'never synced' };

function Pill({ tone, icon, children, large, hint }: { tone: Tone; icon: React.ReactNode; children: React.ReactNode; large?: boolean; hint?: string }) {
  const el = (
    <span
      className={`pill${large ? ' lg' : ''}`}
      style={{
        color: tone.fg,
        background: `color-mix(in srgb, ${tone.solid} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone.solid} 28%, transparent)`,
      }}
    >
      {icon}
      {children}
    </span>
  );
  return hint ? <Tooltip title={hint}>{el}</Tooltip> : el;
}

export function StatusTag({ status, children, large, hint = true }: { status: JobStatus; children?: React.ReactNode; large?: boolean; hint?: boolean }) {
  const { token } = theme.useToken();
  return (
    <Pill tone={statusTone(token, status)} icon={STATUS_ICON[status]} large={large} hint={hint ? STATUS_HINT[status] : undefined}>
      <span data-testid="status-text">{children ?? label(status)}</span>
    </Pill>
  );
}

export function HealthTag({ health, large }: { health: RepoHealth; large?: boolean }) {
  const { token } = theme.useToken();
  return (
    <Pill tone={healthTone(token, health)} icon={HEALTH_ICON[health]} large={large}>
      {HEALTH_TEXT[health] ?? label(health)}
    </Pill>
  );
}

/** Small coloured dot, pulsing when `live`. */
export function Dot({ color, live, title }: { color: string; live?: boolean; title?: string }) {
  return <span className={`dotmark${live ? ' pulse' : ''}`} style={{ background: color, color }} title={title} aria-hidden={!title} />;
}
