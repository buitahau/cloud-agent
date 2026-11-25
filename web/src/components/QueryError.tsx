import { Alert, Button, Result } from 'antd';
import { Link } from 'react-router';
import { ApiError } from '../api/client';

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
