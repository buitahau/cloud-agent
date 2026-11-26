import { Alert, App, Button, Input, Modal, Switch } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/client';
import { useDeleteRepo, useUpdateRepo } from '../api/queries';
import type { RepoStatus } from '../api/types';
import { plural } from '../lib/format';
import { ApiErrorAlert } from './QueryError';

/** Enable/disable switch. Disabling asks for confirmation first. */
export function EnabledSwitch({ repo: r }: { repo: RepoStatus }) {
  const m = useUpdateRepo(r.id); // no token in these variables
  const { modal, message } = App.useApp();
  const run = async (enabled: boolean) => {
    try { await m.mutateAsync({ enabled }); message.success(`${r.id} ${enabled ? 'enabled' : 'disabled'}`); }
    catch (e) { message.error(errorMessage(e)); }
  };
  const onChange = (checked: boolean) => {
    if (checked) { void run(true); return; }
    modal.confirm({
      title: `Disable ${r.id}?`,
      content: (
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          <li>New jobs for this repo are refused (HTTP 409).</li>
          <li>{r.queued ? `Its ${plural(r.queued, 'queued job')} will fail with “repo disabled”.` : 'Queued jobs fail with “repo disabled” (none queued right now).'}</li>
          <li>{r.running_job_id ? 'The running job is allowed to finish.' : 'A running job would be allowed to finish.'}</li>
          <li>You can enable it again at any time.</li>
        </ul>
      ),
      okText: 'Disable',
      okButtonProps: { danger: true },
      onOk: () => run(false),
    });
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <Switch checked={r.enabled} loading={m.isPending} onChange={onChange} aria-label={r.enabled ? 'Disable repository' : 'Enable repository'} />
      {r.enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

export function DeleteRepoModal({ repo, open, onClose }: { repo: RepoStatus; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onCancel={onClose} title={`Delete ${repo.id}?`} footer={null} destroyOnHidden width={520}>
      <DeleteForm repo={repo} onCancel={onClose} />
    </Modal>
  );
}

function DeleteForm({ repo: r, onCancel }: { repo: RepoStatus; onCancel: () => void }) {
  const nav = useNavigate();
  const { message } = App.useApp();
  const del = useDeleteRepo(r.id, () => { nav('/', { replace: true }); message.success(`Deleted ${r.id}`); });
  const [typed, setTyped] = useState(''); // the repo id, not a secret
  const active = r.queued + r.counts.queued + r.counts.pulling + r.counts.running > 0 || Boolean(r.running_job_id);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (typed === r.id) del.mutate(); }}>
      <p style={{ marginTop: 0 }}>
        This removes the repository, its stored token and its workspace clone on the server. Job history is kept.
        This can’t be undone.
      </p>
      {active && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          title="This repo has queued or running jobs"
          description="Deleting is refused until none are left: disable it first and wait for them to finish." />
      )}
      <ApiErrorAlert error={del.error} />
      <label htmlFor="confirm-repo-id" style={{ display: 'block', marginBottom: 6 }}>
        Type <strong className="mono">{r.id}</strong> to confirm
      </label>
      <Input id="confirm-repo-id" className="mono" autoComplete="off" spellCheck={false} autoFocus value={typed}
        onChange={(e) => { setTyped(e.target.value); if (del.error) del.reset(); }} />
      <div className="form-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="primary" danger htmlType="submit" disabled={typed !== r.id} loading={del.isPending}>Delete repository</Button>
      </div>
    </form>
  );
}
