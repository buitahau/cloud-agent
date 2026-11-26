import { App, Form, Input, Modal } from 'antd';
import { useSetToken } from '../api/queries';
import type { RepoStatus } from '../api/types';
import { httpsOrigin, tokenHint } from '../lib/repoRules';
import { ApiErrorAlert } from './QueryError';
import { FormActions, tokenRules } from './RepoForm';
import { TimeAgo } from './ui';

/** Set/replace the https token. The form body (and the mutation holding the token) unmounts on close. */
export function TokenModal({ repo, open, onClose }: { repo: RepoStatus; open: boolean; onClose: () => void }) {
  const has = Boolean(repo.auth.token);
  return (
    <Modal open={open} onCancel={onClose} title={`${has ? 'Replace' : 'Set'} token · ${repo.id}`} footer={null}
      destroyOnHidden maskClosable={false} width={520}>
      <TokenForm repo={repo} onDone={onClose} />
    </Modal>
  );
}

function TokenForm({ repo: r, onDone }: { repo: RepoStatus; onDone: () => void }) {
  const [form] = Form.useForm<{ token: string }>();
  const set = useSetToken(r.id);
  const { message } = App.useApp();
  return (
    <Form form={form} layout="vertical" autoComplete="off" preserve={false} disabled={set.isPending}
      onValuesChange={() => { if (set.error) set.reset(); }}
      onFinish={({ token }) => set.mutate(token, {
        onSuccess: () => { form.resetFields(); message.success('Token saved'); onDone(); },
      })}>
      <p className="muted" style={{ marginTop: 0 }}>
        Used for git fetch over https ({httpsOrigin(r.url_display) ?? r.url_display}). It is stored encrypted and never
        shown again; only the last 4 characters are kept as a hint.
        {r.auth.token && <> Current token <span className="mono">{tokenHint(r.auth.token.hint)}</span>, set <TimeAgo at={r.auth.token.updated_at} />. The next sync uses the new token.</>}
      </p>
      <ApiErrorAlert error={set.error} />
      <Form.Item name="token" label="Access token" rules={tokenRules(true)}>
        <Input.Password autoComplete="new-password" spellCheck={false} autoFocus placeholder="Paste the access token" />
      </Form.Item>
      <FormActions pending={set.isPending} okText="Save token" onCancel={onDone} />
    </Form>
  );
}
