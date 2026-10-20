import { Link } from '@tanstack/react-router';
import { useSpaces, useUpdates, useWorkspace } from '../lib/queries.js';
import { loadSession } from '../lib/session.js';
import { relativeTime, updateSentence } from '../lib/updates.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { BookIcon, InboxIcon } from '../components/icons.js';
import { ErrorNote, Loading } from '../components/ui.js';

/** The newest changes in the workspace, as links to their pages. */
function RecentChanges() {
  const { tenant } = useWorkspace();
  const { data: items, error, isPending } = useUpdates(8);
  const selfId = loadSession()?.user.id ?? null;
  const now = new Date();

  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-2">
      <h2 id="home-recent" className="text-sm font-medium text-muted">
        Recent changes
      </h2>
      {isPending && <Loading what="changes" />}
      <ErrorNote error={error} />
      {items && items.length === 0 && <p className="text-sm text-muted">Nothing has changed yet.</p>}
      {items && items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((item) => {
            const { who, what } = updateSentence(item, selfId);
            return (
              <li key={item.versionId}>
                <DocumentLink
                  tenantSlug={tenant.slug}
                  kind={item.document.kind}
                  id={item.document.id}
                  className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{who}</span> <span className="text-muted">{what}</span>
                    <span className="text-muted"> · {item.document.spaceName}</span>
                  </span>
                  <time dateTime={item.createdAt} className="shrink-0 text-xs text-muted">
                    {relativeTime(item.createdAt, now)}
                  </time>
                </DocumentLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** `/w/$tenantSlug`: a welcome, the spaces the person can open, and what changed lately. */
export function WorkspaceHomePage() {
  const { tenant } = useWorkspace();
  const { data: spaces, error, isPending } = useSpaces();
  const user = loadSession()?.user;

  if (isPending) return <Loading what="spaces" />;
  if (error) return <ErrorNote error={error} />;

  const open = spaces.filter((s) => s.archivedAt === null);

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-4xl font-bold tracking-tight">{tenant.name}</h1>
        {user && <p className="text-muted">Welcome back, {user.name}.</p>}
      </header>

      <section aria-labelledby="home-spaces" className="flex flex-col gap-2">
        <h2 id="home-spaces" className="text-sm font-medium text-muted">
          Spaces
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted">You cannot see any space in this workspace yet.</p>
        ) : (
          <ul className="flex flex-col">
            {open.map((space) => (
              <li key={space.id}>
                <Link
                  to="/w/$tenantSlug/s/$spaceSlug"
                  params={{ tenantSlug: tenant.slug, spaceSlug: space.slug }}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
                >
                  <span className="text-lg text-muted">{space.kind === 'inbox' ? <InboxIcon /> : <BookIcon />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{space.name}</span>
                    <span className="block text-xs text-muted">
                      Your role: {space.myRole}
                      {' · '}
                      {space.reviewRequired ? 'Changes need review before they are indexed' : 'Changes are indexed directly'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecentChanges />
    </div>
  );
}
