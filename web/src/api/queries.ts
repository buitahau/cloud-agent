import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { enc, getJson } from './client';
import type { JobDetail, JobPage, RepoStatus, Summary } from './types';

export const POLL_MS = 5000;
const PAGE_SIZE = 50;

export const keys = {
  summary: ['summary'] as const,
  repos: ['repos'] as const,
  repo: (id: string) => ['repo', id] as const,
  jobs: (repo: string, statuses: string[]) => ['jobs', repo, statuses.join(',')] as const,
  job: (id: string) => ['job', id] as const,
};

export const useSummary = () =>
  useQuery({ queryKey: keys.summary, queryFn: () => getJson<Summary>('/summary'), refetchInterval: POLL_MS });

export const useRepos = (poll = true) =>
  useQuery({ queryKey: keys.repos, queryFn: () => getJson<RepoStatus[]>('/repos'), refetchInterval: poll ? POLL_MS : false });

export const useRepo = (id: string) =>
  useQuery({
    queryKey: keys.repo(id),
    queryFn: () => getJson<RepoStatus>(`/repos/${enc(id)}`),
    refetchInterval: POLL_MS,
    retry: (n, err) => (err as { status?: number }).status !== 404 && n < 2,
  });

export const useJob = (id: string) =>
  useQuery({
    queryKey: keys.job(id),
    queryFn: () => getJson<JobDetail>(`/jobs/${enc(id)}`),
    retry: (n, err) => (err as { status?: number }).status !== 404 && n < 2,
  });

/** Cursor-paged job list. Polls only while a single page is loaded, so "Load more" doesn't refetch everything. */
export function useJobsInfinite(repo: string, statuses: string[]) {
  const q = useInfiniteQuery({
    queryKey: keys.jobs(repo, statuses),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (repo) p.set('repo', repo);
      if (statuses.length) p.set('status', statuses.join(','));
      if (pageParam) p.set('before', pageParam);
      return getJson<JobPage>(`/jobs?${p}`);
    },
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) <= 1 ? POLL_MS : false),
  });
  return q;
}

/** Small, polled slice of the newest jobs (optionally by status) for overview widgets. Same endpoint as the table. */
export const useRecentJobs = (statuses: string[], limit = 6, repo = '') =>
  useQuery({
    queryKey: ['jobs', 'recent', repo, statuses.join(','), limit],
    queryFn: () => {
      const p = new URLSearchParams({ limit: String(limit) });
      if (statuses.length) p.set('status', statuses.join(','));
      if (repo) p.set('repo', repo);
      return getJson<JobPage>(`/jobs?${p}`);
    },
    refetchInterval: POLL_MS,
  });
