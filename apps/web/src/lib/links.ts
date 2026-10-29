import type { DocumentTitle, LinkTarget, PageConnections } from '@kinote/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace's `?peek=<pageId>`: the page open in the side panel, if any. */
export function parsePeekSearch(search: Record<string, unknown>): { peek?: string } {
  const peek = typeof search.peek === 'string' && UUID.test(search.peek) ? search.peek.toLowerCase() : undefined;
  return peek ? { peek } : {};
}

/** The most ids the titles endpoint takes at once (`DocumentTitlesQuerySchema`). */
const TITLES_PER_REQUEST = 100;

/**
 * Loads link titles in batches: ids asked for in the same tick go out as one
 * request (a page full of links asks once). Null means the caller can't read
 * the document, or it is archived: "Page unavailable".
 */
export function createTitleBatcher(fetch: (ids: string[]) => Promise<DocumentTitle[]>) {
  let waiting: Array<{ id: string; resolve: (t: DocumentTitle | null) => void; reject: (e: unknown) => void }> = [];
  const flush = () => {
    const batch = waiting;
    waiting = [];
    const ids = [...new Set(batch.map((w) => w.id))];
    for (let i = 0; i < ids.length; i += TITLES_PER_REQUEST) {
      const chunk = new Set(ids.slice(i, i + TITLES_PER_REQUEST));
      const mine = batch.filter((w) => chunk.has(w.id));
      fetch([...chunk]).then(
        (titles) => {
          const byId = new Map(titles.map((t) => [t.id, t]));
          for (const w of mine) w.resolve(byId.get(w.id) ?? null);
        },
        (err) => {
          for (const w of mine) w.reject(err);
        }
      );
    }
  };
  return (id: string) =>
    new Promise<DocumentTitle | null>((resolve, reject) => {
      if (waiting.length === 0) queueMicrotask(flush);
      waiting.push({ id: id.toLowerCase(), resolve, reject });
    });
}

export type LinkMenuEntry =
  | { kind: 'target'; target: LinkTarget; title: string; subtext: string }
  | { kind: 'new'; title: string; newTitle: string };

/**
 * What the `[[` menu offers for a query: matching pages (not the page being
 * edited), then "New page" named by the query when no page has exactly that
 * title and the person may create one here.
 */
export function linkMenuEntries(
  targets: LinkTarget[],
  query: string,
  opts: { canCreate: boolean; selfId: string | null }
): LinkMenuEntry[] {
  const entries: LinkMenuEntry[] = targets
    .filter((t) => t.id !== opts.selfId)
    .map((t) => ({
      kind: 'target',
      target: t,
      title: t.title,
      subtext: t.parentTitle ? `${t.spaceName} / ${t.parentTitle}` : t.spaceName,
    }));
  const clean = query.trim();
  const exact = targets.some((t) => t.title.toLowerCase() === clean.toLowerCase());
  if (opts.canCreate && clean !== '' && !exact) {
    entries.push({ kind: 'new', title: `New page "${clean}"`, newTitle: clean });
  }
  return entries;
}

/** How many pages a page is connected to, for the section's heading. */
export function connectionCount(c: PageConnections): number {
  return new Set([...c.linkedFrom, ...c.updatedBy, ...c.updated].map((p) => p.pageId)).size;
}

/** The "From:" chips of a page: each block a document page's facts were written to. */
export function blockSourcesOf(c: PageConnections): Array<{ blockId: string; pageId: string; title: string }> {
  return c.updatedBy.flatMap((u) => u.blockIds.map((blockId) => ({ blockId, pageId: u.pageId, title: u.title })));
}
