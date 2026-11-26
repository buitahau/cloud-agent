import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { enc, getJson, sendJson } from './client';
import type { AuditPage, JobDetail, JobPage, RepoCreate, RepoPatch, RepoStatus, Summary } from './types';

export const POLL_MS = 5000;
const PAGE_SIZE = 50;

export const keys = {
  summary: ['summary'] as const,
  repos: ['repos'] as const,
  repo: (id: string) => ['repo', id] as const,
  jobs: (repo: string, statuses: string[]) => ['jobs', repo, statuses.join(',')] as const,
  job: (id: string) => ['job', id] as const,
  audit: (repo: string) => ['audit', repo] as const,
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

/** Audit log, newest first, cursor = audit id. Not polled: our own writes invalidate it. */
export const useAuditInfinite = (repo: string) =>
  useInfiniteQuery({
    queryKey: keys.audit(repo),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (repo) p.set('repo', repo);
      if (pageParam !== null) p.set('before', String(pageParam));
      return getJson<AuditPage>(`/audit?${p}`);
    },
    getNextPageParam: (last) => last.next,
  });

// ---- writes ----
// Mutations that carry a token use gcTime 0 and must be called inside the modal body (unmounted on close), so
// mutation `variables` (which hold the token) live no longer than the form. Never put a token in a query key.

const refreshRepo = (qc: QueryClient, id: string) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: keys.repo(id) }),
    qc.invalidateQueries({ queryKey: keys.repos }),
    qc.invalidateQueries({ queryKey: keys.audit(id) }),
  ]);

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: RepoCreate) => sendJson<RepoStatus>('POST', '/repos', body),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: keys.repos }), qc.invalidateQueries({ queryKey: keys.summary })]),
  });
}

export function useUpdateRepo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (patch: RepoPatch) => sendJson<RepoStatus>('PATCH', `/repos/${enc(id)}`, patch),
    onSuccess: (st, patch) => {
      qc.setQueryData<RepoStatus>(keys.repo(id), (old) => (old ? { ...old, ...st } : st)); // instant switch/header
      const extra = 'enabled' in patch // disabling fails queued jobs
        ? [qc.invalidateQueries({ queryKey: ['jobs'] }), qc.invalidateQueries({ queryKey: keys.summary })]
        : [];
      return Promise.all([refreshRepo(qc, id), ...extra]);
    },
  });
}

export function useSetToken(id: string) {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (token: string) => sendJson('PUT', `/repos/${enc(id)}/token`, { token }),
    onSuccess: () => refreshRepo(qc, id),
  });
}

/** onDeleted runs first (navigate away) so the repo page doesn't refetch a 404 before unmounting. */
export function useDeleteRepo(id: string, onDeleted: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson('DELETE', `/repos/${enc(id)}`),
    onSuccess: () => {
      onDeleted();
      qc.removeQueries({ queryKey: keys.repo(id) });
      qc.removeQueries({ queryKey: keys.audit(id) });
      return Promise.all([qc.invalidateQueries({ queryKey: keys.repos }), qc.invalidateQueries({ queryKey: keys.summary })]);
    },
  });
}
