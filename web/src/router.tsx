import { createBrowserRouter } from 'react-router';
import { AppLayout } from './layout/AppLayout';
import { OverviewPage } from './pages/OverviewPage';
import { NotFound } from './pages/NotFound';
import { JobsPage } from './pages/JobsPage';
import { RepoPage } from './pages/RepoPage';
import { JobPage } from './pages/JobPage';

export const router = createBrowserRouter(
  [
    {
      element: <AppLayout />,
      children: [
        { index: true, element: <OverviewPage /> },
        { path: 'jobs', element: <JobsPage /> },
        { path: 'repos/:id', element: <RepoPage /> },
        { path: 'jobs/:id', element: <JobPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: '/admin' },
);
