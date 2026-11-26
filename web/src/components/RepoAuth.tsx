import { KeyOutlined, WarningOutlined } from '@ant-design/icons';
import { theme, Tooltip } from 'antd';
import type { RepoAuth } from '../api/types';
import { tokenHint } from '../lib/repoRules';
import { TimeAgo } from './ui';

/** Credential status. Never shows a secret: only the server's 4-char hint. */
export function AuthInfo({ auth }: { auth: RepoAuth }) {
  const { token } = theme.useToken();
  if (auth.kind === 'https') {
    return auth.token ? (
      <span data-testid="auth-info"><KeyOutlined /> token <span className="mono">{tokenHint(auth.token.hint)}</span>
        <span className="muted"> · set <TimeAgo at={auth.token.updated_at} /></span></span>
    ) : (
      <span data-testid="auth-info" style={{ color: token.colorWarningText }}><WarningOutlined /> no token set</span>
    );
  }
  if (auth.kind === 'ssh') {
    const p = auth.ssh_key_path ?? '';
    return (
      <Tooltip title={p || 'no key path'}>
        <span data-testid="auth-info"><KeyOutlined /> ssh key <span className="mono">{p.split('/').pop() || '—'}</span></span>
      </Tooltip>
    );
  }
  return <span data-testid="auth-info" className="muted">local path · no credentials</span>;
}
