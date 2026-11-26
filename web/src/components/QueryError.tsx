import { Alert, Button, Result } from 'antd';
import { Link } from 'react-router';
import { ApiError, errorMessage } from '../api/client';

export function QueryError({ error, what }: { error: unknown; what: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Result
        status="404"
        title={`${what} not found`}
        subTitle="It may have been removed, or the link is wrong. Job history in memory is lost when the server restarts."
        extra={<Link to="/"><Button type="primary">Back to overview</Button></Link>}
      />
    );
  }
  return (
    <Alert
      type="error"
      showIcon
      title={`Could not load ${what}`}
      description={(error as Error)?.message}
      action={<Button size="small" onClick={() => location.reload()}>Reload</Button>}
    />
  );
}

/** Inline error for a failed write: server `error`, plus the `problems` list when there are several. */
export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const problems = e?.problems ?? [];
  const title = problems.length === 1 ? problems[0] : problems.length > 1 ? 'The server rejected these settings' : errorMessage(error);
  const description = problems.length > 1
    ? <ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
    : e?.status === 403
      ? 'The server refused a cross-origin write. Behind a reverse proxy, forward the Host header or set TRUST_PROXY (README, "Behind a proxy").'
      : undefined;
  return <Alert type="error" showIcon role="alert" style={{ marginBottom: 16 }} title={title} description={description} />;
}
