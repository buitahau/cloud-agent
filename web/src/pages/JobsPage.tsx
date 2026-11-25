import { Typography } from 'antd';
import { JobsTable } from '../components/JobsTable';

export function JobsPage() {
  return (
    <>
      <Typography.Title level={2}>Jobs</Typography.Title>
      <JobsTable />
    </>
  );
}
