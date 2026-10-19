import { useSearch } from '@tanstack/react-router';
import { useSpaces, useWorkspace } from '../lib/queries.js';
import { Card, ErrorNote, Loading } from '../components/ui.js';

/** `/w/$tenantSlug`: the chosen space's summary. Pages and the editor arrive with the next screens. */
export function WorkspaceHomePage() {
  const { tenant } = useWorkspace();
  const { space: slug } = useSearch({ from: '/w/$tenantSlug' });
  const { data: spaces, error, isPending } = useSpaces();

  if (isPending) return <Loading what="spaces" />;
  if (error) return <ErrorNote error={error} />;

  const open = spaces.filter((s) => s.archivedAt === null);
  const space = open.find((s) => s.slug === slug) ?? open[0];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{space ? space.name : tenant.name}</h1>
      {space ? (
        <Card>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-slate-500">Your role</dt>
            <dd>{space.myRole}</dd>
            <dt className="text-slate-500">Review</dt>
            <dd>
              {space.reviewRequired ? 'Changes need review before they are indexed' : 'Changes are indexed directly'}
            </dd>
          </dl>
        </Card>
      ) : (
        <p className="text-sm text-slate-600">You cannot see any space in this workspace yet.</p>
      )}
    </div>
  );
}
