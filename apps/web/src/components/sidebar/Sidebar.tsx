import { Link } from '@tanstack/react-router';
import { adminScreens } from '../../lib/console.js';
import { useReviews, useSpaces, useWorkspace } from '../../lib/queries.js';
import { BookIcon, InboxIcon, SearchIcon, SettingsIcon, SidebarIcon, ReviewsIcon } from '../icons.js';
import { AccountRow } from './AccountRow.js';
import { ROW, ROW_ACTIVE, RowContent } from './NavRow.js';
import { WorkspaceMenu } from './WorkspaceMenu.js';

function SectionLabel({ children }: { children: string }) {
  return <h2 className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted">{children}</h2>;
}

/** The Spaces list (a flat list of spaces for now; the page tree nests under each one). */
function SpacesSection() {
  const { tenant } = useWorkspace();
  const { data: spaces = [] } = useSpaces();
  const open = spaces.filter((s) => s.archivedAt === null);
  if (open.length === 0) return null;
  return (
    <>
      <SectionLabel>Spaces</SectionLabel>
      <ul className="flex flex-col gap-px">
        {open.map((space) => (
          <li key={space.id}>
            <Link
              to="/w/$tenantSlug/s/$spaceSlug"
              params={{ tenantSlug: tenant.slug, spaceSlug: space.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE }}
            >
              <RowContent icon={space.kind === 'inbox' ? <InboxIcon /> : <BookIcon />} label={space.name} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The one sidebar of the console: the workspace, search and reviews, the
 * spaces, and the account foot. `onCollapse` is set where the sidebar is a
 * column that can be hidden.
 */
export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const { tenant, role } = useWorkspace();
  const { data: waiting } = useReviews();
  const screens = adminScreens(role);

  return (
    <div className="flex h-full flex-col gap-1 px-2 py-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <WorkspaceMenu />
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl+\)"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-base text-muted hover:bg-hover"
          >
            <SidebarIcon />
          </button>
        )}
      </div>

      <nav aria-label="Workspace" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ul className="flex flex-col gap-px pt-1">
          <li>
            <Link
              to="/w/$tenantSlug/search"
              params={{ tenantSlug: tenant.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE }}
            >
              <RowContent icon={<SearchIcon />} label="Search" />
            </Link>
          </li>
          <li>
            <Link
              to="/w/$tenantSlug/reviews"
              params={{ tenantSlug: tenant.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE }}
            >
              <RowContent icon={<ReviewsIcon />} label="Reviews" count={waiting?.length ?? 0} countLabel="waiting" />
            </Link>
          </li>
          {screens.length > 0 && (
            <li>
              <Link
                to={screens[0]!.to}
                params={{ tenantSlug: tenant.slug }}
                className={ROW}
                activeProps={{ className: ROW_ACTIVE }}
              >
                <RowContent icon={<SettingsIcon />} label="Settings & members" />
              </Link>
            </li>
          )}
        </ul>
        <SpacesSection />
      </nav>

      <AccountRow />
    </div>
  );
}
