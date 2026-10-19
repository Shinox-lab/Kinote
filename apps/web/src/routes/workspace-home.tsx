import { Link } from '@tanstack/react-router';
import { useSpaces, useWorkspace } from '../lib/queries.js';
import { Card, ErrorNote, Loading } from '../components/ui.js';

/** `/w/$tenantSlug`: the spaces the user can open, each linking to its page tree. */
export function WorkspaceHomePage() {
  const { tenant } = useWorkspace();
  const { data: spaces, error, isPending } = useSpaces();

  if (isPending) return <Loading what="spaces" />;
  if (error) return <ErrorNote error={error} />;

  const open = spaces.filter((s) => s.archivedAt === null);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{tenant.name}</h1>
      {open.length === 0 ? (
        <p className="text-sm text-slate-600">You cannot see any space in this workspace yet.</p>
      ) : (
        <Card title="Spaces">
          <ul className="divide-y divide-slate-100">
            {open.map((space) => (
              <li key={space.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
                <Link
                  to="/w/$tenantSlug/s/$spaceSlug"
                  params={{ tenantSlug: tenant.slug, spaceSlug: space.slug }}
                  className="text-sm font-semibold text-indigo-700 hover:underline"
                >
                  {space.name}
                </Link>
                <span className="text-xs text-slate-500">Your role: {space.myRole}</span>
                <span className="text-xs text-slate-500">
                  {space.reviewRequired ? 'Changes need review before they are indexed' : 'Changes are indexed directly'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
