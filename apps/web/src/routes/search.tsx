import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AskCitation, AskResponse, SearchPassage } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { useSpaces, useWorkspace } from '../lib/queries.js';
import { answerMarkdown, headingLine, queryAllows } from '../lib/search.js';
import { useRecentSearches, type RecentSearch } from '../lib/recentSearches.js';
import { relativeTime } from '../lib/pageStatus.js';
import { loadSession } from '../lib/session.js';
import { isKnownIcon } from '../lib/emoji.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { FileTypeTile } from '../components/FileTypeTile.js';
import { PageIcon, SearchIcon, SparkleIcon } from '../components/icons.js';
import { ErrorNote, Loading } from '../components/ui.js';

const RESULT_FIRST = 6;

// Marked and DOMPurify are heavy: they load only once an answer is on screen.
const MarkdownText = lazy(() => import('../viewers/MarkdownText.js'));

function SourceLink({
  target,
  children,
  className,
}: {
  target: { documentId: string; documentKind: 'page' | 'file'; pageFrom: number | null };
  children: ReactNode;
  className: string;
}) {
  const { tenant } = useWorkspace();
  return (
    <DocumentLink
      tenantSlug={tenant.slug}
      kind={target.documentKind}
      id={target.documentId}
      page={target.pageFrom}
      className={className}
    >
      {children}
    </DocumentLink>
  );
}

/** The opt-in answer above the results: its text, numbered citation links, and the sources with a quote each. */
function Answer({
  answer,
  spaces,
}: {
  answer: AskResponse;
  spaces: { id: string; name: string }[];
}) {
  const { tenant } = useWorkspace();
  const navigate = useNavigate();
  const source = answerMarkdown(answer.answer, answer.citations, tenant.slug, window.location.origin);
  const spaceName = (citation: AskCitation) => spaces.find((s) => s.id === citation.spaceId)?.name ?? '';

  /** Citation links point into the workspace; follow them without leaving the app. */
  function follow(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (anchor.origin !== window.location.origin) return;
    event.preventDefault();
    navigate({ href: `${anchor.pathname}${anchor.search}${anchor.hash}` });
  }

  return (
    <section aria-label="Answer" className="flex flex-col gap-3 rounded-lg border border-review-line bg-review-bg p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-review-text">
        Answer · from {answer.citations.length} {answer.citations.length === 1 ? 'passage' : 'passages'}
      </h2>
      {answer.foundRelevant ? (
        <>
          <div onClick={follow}>
            <Suspense fallback={<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{answer.answer}</p>}>
              <MarkdownText source={source} />
            </Suspense>
          </div>
          {answer.citations.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-fg">Sources</h3>
              <ol aria-label="Sources" className="flex flex-col gap-2">
                {answer.citations.map((citation, index) => (
                  <li key={citation.chunkId} className="text-xs">
                    <span className="text-muted">[{index + 1}] </span>
                    <SourceLink target={citation} className="font-medium text-accent-text hover:underline">
                      {citation.documentTitle}
                    </SourceLink>
                    {spaceName(citation) && <span className="text-muted"> · {spaceName(citation)}</span>}
                    <p className="mt-0.5 line-clamp-1 break-words text-muted">{citation.quote}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-fg">No answer was found in the pages you can read.</p>
      )}
    </section>
  );
}

function ResultRow({ passage, spaceName }: { passage: SearchPassage; spaceName: string }) {
  const { tenant } = useWorkspace();
  const where =
    passage.documentKind === 'file'
      ? passage.pageFrom !== null
        ? `Page ${passage.pageFrom}`
        : 'File'
      : passage.headingPath.length > 0
        ? headingLine(passage.headingPath)
        : 'Start of the page';
  return (
    <li>
      <DocumentLink
        tenantSlug={tenant.slug}
        kind={passage.documentKind}
        id={passage.documentId}
        page={passage.pageFrom}
        className="flex items-start gap-3 rounded-md px-1 py-3 hover:bg-hover"
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-base leading-none text-muted">
          {passage.documentKind === 'file' ? (
            <FileTypeTile name={passage.versionTitle} size={20} />
          ) : isKnownIcon(passage.icon) ? (
            <span aria-hidden="true">{passage.icon}</span>
          ) : (
            <PageIcon />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-semibold text-fg">{passage.versionTitle}</span>
            <span className="text-[10.5px] text-muted">{spaceName}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block whitespace-pre-wrap break-words text-[12.5px] leading-snug text-fg">
            {passage.text}
          </span>
          <span className="mt-1 block text-[10.5px] text-muted">
            {where} · v{passage.versionNumber}
          </span>
        </span>
      </DocumentLink>
    </li>
  );
}

/** The person's recent searches, shown while the box is empty: pick one to run it again (its answer comes back too). */
function RecentList({
  list,
  spaces,
  onOpen,
  onRemove,
}: {
  list: RecentSearch[];
  spaces: Array<{ id: string; name: string }>;
  onOpen: (r: RecentSearch) => void;
  onRemove: (r: RecentSearch) => void;
}) {
  if (list.length === 0) return null;
  return (
    <section aria-label="Recent searches" className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Recent searches</h2>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((r) => (
          <li key={`${r.space}:${r.q}`} className="flex items-center gap-2">
            <button type="button" onClick={() => onOpen(r)} className="flex min-w-0 flex-1 items-baseline gap-2 py-2 text-left hover:underline max-md:min-h-11">
              <span className="min-w-0 truncate text-sm text-fg">{r.q}</span>
              {r.space !== '' && <span className="shrink-0 text-xs text-muted">{spaces.find((s) => s.id === r.space)?.name ?? ''}</span>}
              {r.answer && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent-text">Answered</span>}
              <span className="ml-auto shrink-0 text-xs text-muted">{relativeTime(r.at)}</span>
            </button>
            <button type="button" aria-label={`Remove ${r.q} from recent searches`} onClick={() => onRemove(r)} className="rounded px-2 py-1 text-muted hover:bg-hover hover:text-fg max-md:min-h-11">
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `/w/$tenantSlug/search`: a shareable semantic search, with an optional cited answer above the rows. */
export function SearchPage() {
  const { tenant } = useWorkspace();
  const { data: spaces = [] } = useSpaces();
  const params = useSearch({ from: '/w/$tenantSlug/search' });
  const navigate = useNavigate();
  const q = params.q ?? '';
  const spaceId = params.space ?? '';
  const [draft, setDraft] = useState(q);
  // In the address, so leaving Search while an answer is on its way and coming back still shows it.
  const answerWanted = params.ask === true;
  const [showAll, setShowAll] = useState(false);
  const allows = queryAllows(q);
  const recent = useRecentSearches(tenant.id, loadSession()?.user.id ?? '');
  const queryClient = useQueryClient();
  const askKey = (question: string, space: string) => ['t', tenant.id, 'ask', question, space];

  useEffect(() => setDraft(q), [q]);
  useEffect(() => setShowAll(false), [q, spaceId]);

  const filter = spaceId === '' ? {} : { space_ids: [spaceId] };
  const search = useQuery({
    queryKey: ['t', tenant.id, 'search', q, spaceId],
    queryFn: () => api.search({ query: q.trim(), limit: 50, ...filter }),
    enabled: q.trim() !== '' && allows.search,
  });
  // Not refetched by itself: coming back to Search shows the answer (or the request still running) as it was.
  const ask = useQuery({
    queryKey: askKey(q, spaceId),
    queryFn: () => api.ask({ question: q.trim(), ...filter }),
    enabled: answerWanted && q.trim() !== '' && allows.ask,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

  // Every search that ran goes to the top of the recent list; an answer is kept with its search.
  useEffect(() => {
    if (search.isSuccess && q.trim() !== '') recent.add({ q, space: spaceId, at: new Date().toISOString() });
  }, [search.isSuccess, q, spaceId]);
  useEffect(() => {
    const kept = recent.list.find((r) => r.space === spaceId && r.q.toLowerCase() === q.trim().toLowerCase());
    if (ask.data && ask.dataUpdatedAt > (kept?.answer ? Date.parse(kept.at) : 0)) {
      recent.add({ q, space: spaceId, at: new Date(ask.dataUpdatedAt).toISOString(), answer: ask.data });
    }
  }, [ask.dataUpdatedAt]);

  /** "Get an answer" always asks the model afresh. */
  function askNow() {
    queryClient.removeQueries({ queryKey: askKey(q, spaceId), exact: true });
    go(q, spaceId, true);
  }

  /** A recent search comes back with its kept answer, if it had one; "Ask again" refreshes it. */
  function reopen(r: RecentSearch) {
    if (r.answer) queryClient.setQueryData(askKey(r.q, r.space), r.answer, { updatedAt: Date.parse(r.at) });
    go(r.q, r.space, r.answer !== undefined);
  }

  const scopes = [
    { value: '', label: 'All spaces' },
    ...spaces.filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name })),
  ];

  function go(nextQuery: string, nextSpace: string, withAnswer = false) {
    navigate({
      to: '/w/$tenantSlug/search',
      params: { tenantSlug: tenant.slug },
      search: {
        ...(nextQuery.trim() !== '' ? { q: nextQuery.trim() } : {}),
        ...(nextSpace !== '' ? { space: nextSpace } : {}),
        ...(withAnswer ? { ask: true as const } : {}),
      },
    });
  }

  const passages = search.data?.passages ?? [];
  const visible = showAll ? passages : passages.slice(0, RESULT_FIRST);
  const documentCount = new Set(passages.map((p) => p.documentId)).size;

  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Search</span>} />
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4">
        <form
          role="search"
          className="relative w-full"
          onSubmit={(event) => {
            event.preventDefault();
            go(draft, spaceId);
          }}
        >
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon />
          </span>
          <input
            type="search"
            aria-label="Search pages and files"
            placeholder="Search pages and files"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-[46px] w-full rounded-lg border border-line bg-surface py-0 pl-10 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none md:pr-40"
          />
          <label className="mt-2 flex w-fit items-center gap-1 rounded-md border border-line bg-page px-2 py-1 text-xs text-muted max-md:min-h-11 md:absolute md:right-2 md:top-1/2 md:mt-0 md:-translate-y-1/2">
            <span className="sr-only">Scope</span>
            <select
              aria-label="Scope"
              value={spaceId}
              onChange={(event) => go(draft, event.target.value)}
              className="max-w-[8.5rem] appearance-none bg-transparent text-xs text-fg outline-none"
            >
              {scopes.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
                </option>
              ))}
            </select>
            <span aria-hidden="true">⌄</span>
          </label>
        </form>

        {q.trim() === '' && <RecentList list={recent.list} spaces={spaces} onOpen={reopen} onRemove={recent.remove} />}

        {ask.isFetching && <Loading what="answer" />}
        <ErrorNote error={ask.error} />
        {answerWanted && ask.data && (
          <>
            <Answer answer={ask.data} spaces={spaces} />
            {!ask.isFetching && (
              <p className="-mt-2 flex items-center gap-2 text-xs text-muted">
                Answered {relativeTime(new Date(ask.dataUpdatedAt).toISOString())}
                <button type="button" onClick={() => void ask.refetch()} className="font-medium text-accent-text hover:underline">
                  Ask again
                </button>
              </p>
            )}
          </>
        )}

        {search.isPending && q.trim() !== '' && <Loading what="results" />}
        <ErrorNote error={search.error} />
        {search.data && q.trim() !== '' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">
                {passages.length} {passages.length === 1 ? 'passage' : 'passages'} · {documentCount}{' '}
                {documentCount === 1 ? 'page' : 'pages'}
              </p>
              <button
                type="button"
                onClick={askNow}
                disabled={!allows.ask || ask.isFetching}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent-text hover:opacity-90 disabled:opacity-50 max-md:min-h-11 max-md:w-full max-md:justify-center"
              >
                <SparkleIcon />
                Get an answer
              </button>
            </div>
            {passages.length === 0 ? (
              <p className="text-sm text-muted">No passages matched.</p>
            ) : (
              <section aria-label="Search results" className="flex flex-col gap-1">
                <ul aria-label="Search results" className="flex flex-col divide-y divide-line">
                  {visible.map((passage) => (
                    <ResultRow
                      key={passage.chunkId}
                      passage={passage}
                      spaceName={spaces.find((s) => s.id === passage.spaceId)?.name ?? ''}
                    />
                  ))}
                </ul>
                {passages.length > RESULT_FIRST && !showAll && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="self-start px-1 py-2 text-xs font-medium text-accent-text hover:underline"
                  >
                    Show more
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
