import { Button, Result } from 'antd';
import { Link } from 'react-router';

export function NotFound() {
  return (
    <Result
      status="404"
      title="Page not found"
      subTitle="This page doesn't exist in the admin console."
      extra={<Link to="/"><Button type="primary">Back to overview</Button></Link>}
    />
  );
}
