import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api.js';
import { useWorkspace } from '../lib/queries.js';

/** The bytes of one file version, fetched with the session; kept briefly so closing and reopening is quick. */
export function useFileBytes(versionId: string) {
  const { tenant } = useWorkspace();
  return useQuery({
    queryKey: ['t', tenant.id, 'versionBytes', versionId],
    queryFn: () => api.versionFile(versionId),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
  });
}
