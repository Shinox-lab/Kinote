// Where a document lives in the console: a page opens the editor, a file its own
// page. Every link that can point at either goes through here, so a file id never
// lands on the page route (or the reverse).

const e = encodeURIComponent;

const isPage = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** The address of a document; `page` and `version` only mean something for a file (pages take the plain address). */
export function documentHref(
  tenantSlug: string,
  kind: 'page' | 'file',
  id: string,
  opts: { page?: number | null; version?: string } = {}
): string {
  if (kind === 'page') return `/w/${e(tenantSlug)}/p/${e(id)}`;
  const query = new URLSearchParams();
  if (isPage(opts.page)) query.set('page', String(opts.page));
  if (opts.version) query.set('v', opts.version);
  const q = query.toString();
  return `/w/${e(tenantSlug)}/f/${e(id)}${q ? `?${q}` : ''}`;
}

/** The search of the file route: a positive whole page number and a version; anything else is dropped. */
export function parseFileSearch(search: Record<string, unknown>): { page?: number; v?: string } {
  const out: { page?: number; v?: string } = {};
  const page = typeof search.page === 'string' ? Number(search.page) : search.page;
  if (isPage(page)) out.page = page;
  if (typeof search.v === 'string' && search.v !== '') out.v = search.v;
  return out;
}
