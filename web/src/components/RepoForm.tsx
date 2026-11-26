import { Alert, App, Button, Form, Input, Modal } from 'antd';
import { useNavigate } from 'react-router';
import { useCreateRepo, useUpdateRepo } from '../api/queries';
import type { RepoCreate, RepoKind, RepoPatch, RepoStatus } from '../api/types';
import {
  hasCredentials, httpsOrigin, MAX_TOKEN_LENGTH, REPO_ID_RE, RESERVED_REPO_IDS, TOKEN_BAD, tokenHint, tokenRequirement,
  tokenWillDrop, urlKind,
} from '../lib/repoRules';
import { ApiErrorAlert } from './QueryError';

const enc = encodeURIComponent;
type Values = { id?: string; url: string; defaultBranch: string; sshKeyPath?: string; token?: string };

const urlRules = [
  { required: true, whitespace: true, message: 'Enter the git URL' },
  {
    validator: (_: unknown, raw?: string) => {
      const v = (raw ?? '').trim();
      if (!v) return Promise.resolve();
      if (/^http:\/\//i.test(v)) return Promise.reject(new Error('Plain http:// is not allowed; use https://'));
      if (hasCredentials(v)) return Promise.reject(new Error('Don’t put credentials in the URL; use the token field'));
      return urlKind(v) ? Promise.resolve() : Promise.reject(new Error('Use https://…, ssh://…, user@host:path, or an absolute path'));
    },
  },
];

export const tokenRules = (required: boolean) => [
  { required, message: 'A token is required for this URL' },
  {
    validator: (_: unknown, v?: string) =>
      !v ? Promise.resolve()
      : v.length > MAX_TOKEN_LENGTH ? Promise.reject(new Error(`At most ${MAX_TOKEN_LENGTH} characters`))
      : TOKEN_BAD.test(v) ? Promise.reject(new Error('Token must not contain spaces or line breaks'))
      : Promise.resolve(),
  },
];

const KIND_TEXT: Record<RepoKind, string> = {
  https: 'https · uses a token',
  ssh: 'ssh · uses a key file on the server',
  local: 'local path · needs ALLOW_LOCAL_REPOS=true',
};

function UrlField({ kind }: { kind: RepoKind | null }) {
  return (
    <Form.Item name="url" label="Git URL" rules={urlRules} extra={kind ? `Detected: ${KIND_TEXT[kind]}` : undefined}>
      <Input className="mono" autoComplete="off" spellCheck={false} placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git" />
    </Form.Item>
  );
}

function BranchField() {
  return (
    <Form.Item name="defaultBranch" label="Default branch" rules={[{ required: true, whitespace: true, message: 'Enter a branch' }]}
      extra="Used when a job doesn’t name a branch.">
      <Input className="mono" autoComplete="off" spellCheck={false} placeholder="main" />
    </Form.Item>
  );
}

function SshKeyField() {
  return (
    <Form.Item name="sshKeyPath" label="SSH key path" rules={[
      { required: true, whitespace: true, message: 'ssh repos need their own key file' },
      { pattern: /^\//, message: 'Must be an absolute path on the server' },
    ]} extra="Absolute path of the private key on the server (inside SSH_KEYS_DIR when set), e.g. /run/ssh-keys/id_ed25519_api">
      <Input className="mono" autoComplete="off" spellCheck={false} placeholder="/run/ssh-keys/id_ed25519_repo" />
    </Form.Item>
  );
}

function TokenField({ required, label, extra }: { required: boolean; label: string; extra: React.ReactNode }) {
  return (
    <Form.Item name="token" label={label} rules={tokenRules(required)} extra={extra}>
      <Input.Password autoComplete="new-password" spellCheck={false} placeholder={required ? 'Paste the access token' : 'Leave empty to keep the current token'} />
    </Form.Item>
  );
}

export function FormActions({ pending, okText, onCancel }: { pending: boolean; okText: string; onCancel: () => void }) {
  return (
    <div className="form-actions">
      <Button onClick={onCancel}>Cancel</Button>
      <Button type="primary" htmlType="submit" loading={pending}>{okText}</Button>
    </div>
  );
}

type ModalProps = ({ mode: 'create' } | { mode: 'edit'; repo: RepoStatus }) & { open: boolean; onClose: () => void };

/** Create/edit dialog. The form body (and its token-bearing mutation) unmounts on close. */
export function RepoFormModal(props: ModalProps) {
  const { open, onClose } = props;
  return (
    <Modal open={open} title={props.mode === 'create' ? 'Add repository' : `Edit ${props.repo.id}`} footer={null}
      destroyOnHidden maskClosable={false} width={560} onCancel={onClose}>
      {props.mode === 'create' ? <CreateForm onDone={onClose} /> : <EditForm repo={props.repo} onDone={onClose} />}
    </Modal>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [form] = Form.useForm<Values>();
  const create = useCreateRepo();
  const nav = useNavigate();
  const { message } = App.useApp();
  const kind = urlKind((Form.useWatch('url', form) ?? '').trim());

  const submit = (v: Values) => {
    const url = v.url.trim();
    const k = urlKind(url);
    const body: RepoCreate = { id: (v.id ?? '').trim(), url, defaultBranch: v.defaultBranch.trim() || 'main' };
    if (k === 'ssh') body.sshKeyPath = (v.sshKeyPath ?? '').trim();
    if (k === 'https') body.token = v.token;
    create.mutate(body, {
      onSuccess: (r) => {
        form.resetFields();
        message.success(`Added ${r.id}`);
        onDone();
        nav(`/repos/${enc(r.id)}`);
      },
    });
  };

  return (
    <Form form={form} layout="vertical" autoComplete="off" preserve={false} requiredMark="optional"
      initialValues={{ defaultBranch: 'main' }} disabled={create.isPending}
      onValuesChange={() => { if (create.error) create.reset(); }} onFinish={submit}>
      <ApiErrorAlert error={create.error} />
      <Form.Item name="id" label="Repo id" rules={[
        { required: true, message: 'Enter an id' },
        { pattern: REPO_ID_RE, message: '1–40 characters: a–z, 0–9 and “-” (not at the start or end)' },
        { validator: (_, v?: string) => (v && RESERVED_REPO_IDS.includes(v) ? Promise.reject(new Error('This name is reserved')) : Promise.resolve()) },
      ]} extra="Used in API paths (POST /<id>/run-agent) and as the workspace folder name. Can’t be changed later.">
        <Input className="mono" autoComplete="off" spellCheck={false} placeholder="web" autoFocus />
      </Form.Item>
      <UrlField kind={kind} />
      <BranchField />
      {kind === 'ssh' && <SshKeyField />}
      {kind === 'https' && (
        <TokenField required label="Access token"
          extra="Stored encrypted on the server and never shown again; only the last 4 characters are kept as a hint." />
      )}
      {kind === 'local' && <Alert type="info" showIcon style={{ marginBottom: 16 }} title="Local paths are only accepted when the server runs with ALLOW_LOCAL_REPOS=true." />}
      <FormActions pending={create.isPending} okText="Add repository" onCancel={onDone} />
    </Form>
  );
}

function EditForm({ repo: r, onDone }: { repo: RepoStatus; onDone: () => void }) {
  const [form] = Form.useForm<Values>();
  const update = useUpdateRepo(r.id);
  const { message } = App.useApp();
  const url = (Form.useWatch('url', form) ?? r.url_display).trim();
  const kind = urlKind(url);
  const urlChanged = url !== r.url_display;
  const need = tokenRequirement(r, url);
  const drops = tokenWillDrop(r, url);
  const busy = Boolean(r.running_job_id) || r.counts.pulling > 0;

  const submit = (v: Values) => {
    const nextUrl = v.url.trim();
    const k = urlKind(nextUrl);
    const patch: RepoPatch = {};
    if (nextUrl !== r.url_display) patch.url = nextUrl;
    const branch = v.defaultBranch.trim();
    if (branch !== r.default_branch) patch.defaultBranch = branch;
    if (k === 'ssh') {
      const p = (v.sshKeyPath ?? '').trim();
      if (p !== (r.auth.ssh_key_path ?? '')) patch.sshKeyPath = p; // only when changed: the server checks the file
    }
    if (k === 'https' && v.token) patch.token = v.token;
    if (!Object.keys(patch).length) { message.info('No changes to save'); onDone(); return; }
    update.mutate(patch, { onSuccess: () => { form.resetFields(); message.success(`Saved ${r.id}`); onDone(); } });
  };

  const tokenLabel = need === 'required' ? 'Access token for the new URL' : r.auth.token ? 'Replace token (optional)' : 'Access token (optional)';
  const tokenExtra = need === 'required'
    ? (r.auth.kind === 'https' && r.auth.token
        ? `Required: the stored token only works for ${httpsOrigin(r.url_display) ?? 'the old host'}.`
        : 'Required: this repo has no token for an https remote yet.')
    : r.auth.token
      ? <>Current token <span className="mono">{tokenHint(r.auth.token.hint)}</span>. Leave empty to keep it.</>
      : 'No token stored: syncs will fail until one is set.';

  return (
    <Form form={form} layout="vertical" autoComplete="off" preserve={false} requiredMark="optional"
      initialValues={{ url: r.url_display, defaultBranch: r.default_branch, sshKeyPath: r.auth.ssh_key_path ?? '' }}
      disabled={update.isPending} onValuesChange={() => { if (update.error) update.reset(); }} onFinish={submit}>
      <ApiErrorAlert error={update.error} />
      <UrlField kind={kind} />
      {urlChanged && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="Changing the URL"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              <li>If it points to a different remote, the workspace clone is deleted; the next job clones again.</li>
              {busy && <li>A job is running: the server refuses URL changes until it finishes.</li>}
              {drops && <li>The stored token ({tokenHint(r.auth.token?.hint ?? '')}) is deleted{kind === 'https' ? ' and replaced by the one below' : ''}.</li>}
            </ul>
          } />
      )}
      <BranchField />
      {kind === 'ssh' && <SshKeyField />}
      {need !== 'none' && <TokenField required={need === 'required'} label={tokenLabel} extra={tokenExtra} />}
      <FormActions pending={update.isPending} okText="Save changes" onCancel={onDone} />
    </Form>
  );
}
