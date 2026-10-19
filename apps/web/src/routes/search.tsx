import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { AskResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { useSpaces, useWorkspace } from '../lib/queries.js';
import { answerSegments, headingLine, queryAllows } from '../lib/search.js';
import { Button, Card, ErrorNote, Loading, SelectField, TextField } from '../components/ui.js';

const ALL_SPACES = '';

function PageLink({ pageId, children, className }: { pageId: string; children: string; className: string }) {
  const { tenant } = useWorkspace();
  return (
    <Link to="/w/$tenantSlug/p/$pageId" params={{ tenantSlug: tenant.slug, pageId }} className={className}>
      {children}
    </Link>
  );
}

/** The answer as plain text; a `[citeAs]` marker in it becomes a numbered link to the cited page. */
function Answer({ answer }: { answer: AskResponse }) {
  const segments = answerSegments(answer.answer, answer.citations);
  return (
    <Card title="Answer">
      <div className="flex flex-col gap-3">
        <p className="whitespace-pre-wrap break-words text-sm">
          {segments.map((s, i) =>
            s.type === 'text' ? (
              s.text
            ) : (
              <PageLink key={i} pageId={s.citation.documentId} className="font-medium text-indigo-700 hover:underline">
                {`[${answer.citations.indexOf(s.citation) + 1}]`}
              </PageLink>
            )
          )}
        </p>
        {!answer.foundRelevant && <p className="text-sm text-slate-600">No answer was found in the pages you can read.</p>}
        {answer.citations.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Sources</h3>
            <ol aria-label="Sources" className="flex flex-col gap-2">
              {answer.citations.map((c, i) => (
                <li key={c.chunkId} className="text-sm">
                  <span className="text-slate-600">[{i + 1}] </span>
                  <PageLink pageId={c.documentId} className="font-medium text-indigo-700 hover:underline">
                    {c.citeAs}
                  </PageLink>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-600">{c.quote}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Card>
  );
}

/** `/w/$tenantSlug/search`: passages that match a query, and an answer built from them with its citations. */
export function SearchPage() {
  const { data: spaces = [] } = useSpaces();
  const [query, setQuery] = useState('');
  const [spaceId, setSpaceId] = useState(ALL_SPACES);
  const search = useMutation({ mutationFn: (body: Parameters<typeof api.search>[0]) => api.search(body) });
  const ask = useMutation({ mutationFn: (body: Parameters<typeof api.ask>[0]) => api.ask(body) });

  const allows = queryAllows(query);
  const filter = spaceId === ALL_SPACES ? {} : { space_ids: [spaceId] };
  const busy = search.isPending || ask.isPending;
  const options = [
    { value: ALL_SPACES, label: 'All spaces' },
    ...spaces.filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Search</h1>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (allows.search && !busy) search.mutate({ query: query.trim(), ...filter });
        }}
      >
        <TextField
          label="Search or ask a question"
          value={query}
          onChange={setQuery}
          hint="Search takes up to 500 characters, Ask up to 1000."
        />
        <div className="w-56">
          <SelectField label="Filter by space" value={spaceId} options={options} onChange={setSpaceId} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!allows.search || busy}>
            Search
          </Button>
          <Button
            variant="secondary"
            disabled={!allows.ask || busy}
            onClick={() => ask.mutate({ question: query.trim(), ...filter })}
          >
            Ask
          </Button>
        </div>
      </form>

      {ask.isPending && <Loading what="answer" />}
      <ErrorNote error={ask.error} />
      {ask.data && !ask.isPending && <Answer answer={ask.data} />}

      {search.isPending && <Loading what="results" />}
      <ErrorNote error={search.error} />
      {search.data && !search.isPending && (
        <section aria-label="Search results" className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Results for &ldquo;{search.variables?.query}&rdquo;</h2>
          {search.data.passages.length === 0 ? (
            <p className="text-sm text-slate-600">No passages matched.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {search.data.passages.map((p) => (
                <li key={p.chunkId}>
                  <Card>
                    <div className="flex flex-col gap-1">
                      <PageLink pageId={p.documentId} className="text-base font-semibold text-indigo-700 hover:underline">
                        {p.versionTitle}
                      </PageLink>
                      {p.headingPath.length > 0 && <p className="text-xs text-slate-600">{headingLine(p.headingPath)}</p>}
                      <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">{p.text}</p>
                      <p className="text-xs text-slate-500">{p.citeAs}</p>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
