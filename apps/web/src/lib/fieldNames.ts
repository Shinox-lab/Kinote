import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FieldDef, FieldNames } from '@living-wiki/contracts';
import { api } from './api.js';
import { useTenantKey } from './queries.js';

/**
 * Names for the person and page values in `valueSets`: people from the
 * mention list of `pageId` (its space's members who can be told), pages by
 * their current title (only ones the viewer can open).
 */
export function useFieldNames(pageId: string, fields: FieldDef[], valueSets: Array<Record<string, unknown>>): FieldNames {
  const pageIds = [
    ...new Set(
      fields
        .filter((f) => f.type === 'page')
        .flatMap((f) => valueSets.flatMap((values) => (Array.isArray(values[f.id]) ? (values[f.id] as string[]) : [])))
    ),
  ].sort();
  const hasPeople = fields.some((f) => f.type === 'person');
  const { data: people } = useQuery({
    queryKey: useTenantKey('mentionable', pageId),
    queryFn: () => api.mentionable(pageId, ''),
    enabled: hasPeople,
    staleTime: 60_000,
  });
  const { data: titles } = useQuery({
    queryKey: useTenantKey('titles', pageIds.join(',')),
    queryFn: () => api.documentTitles(pageIds),
    enabled: pageIds.length > 0,
  });
  return useMemo(
    () => ({
      users: new Map((people ?? []).map((p) => [p.userId, p.name])),
      pages: new Map((titles ?? []).map((t) => [t.id, t.title || 'Untitled'])),
    }),
    [people, titles]
  );
}
