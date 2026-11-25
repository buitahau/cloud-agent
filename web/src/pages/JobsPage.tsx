import { JobsTable } from '../components/JobsTable';
import { PageHeader } from '../components/ui';

export function JobsPage() {
  return (
    <>
      <PageHeader title="Jobs" sub="Every claude -p run across all repositories, newest first. Click a row for details and the live event stream." />
      <JobsTable />
    </>
  );
}
