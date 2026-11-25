import { Alert, Result } from 'antd';
import { Link } from 'react-router';
import { ApiError } from '../api/client';

export function QueryError({ error, what }: { error: unknown; what: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return <Result status="404" title={`${what} not found`} extra={<Link to="/">Back to overview</Link>} />;
  }
  return <Alert type="error" showIcon title={`Could not load ${what}`} description={(error as Error)?.message} />;
}
