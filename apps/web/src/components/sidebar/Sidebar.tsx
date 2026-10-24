import { Link } from '@tanstack/react-router';
import { adminScreens } from '../../lib/console.js';
import { useReviews, useWorkspace } from '../../lib/queries.js';
import { HomeIcon, SearchIcon, SettingsIcon, SidebarIcon, ReviewsIcon } from '../icons.js';
import { AccountRow } from './AccountRow.js';
import { ROW, ROW_ACTIVE, RowContent } from './NavRow.js';
import { UploadPanel } from './UploadPanel.js';
import { SpacesSection } from './SpacesSection.js';
import { WorkspaceMenu } from './WorkspaceMenu.js';

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
        <ul aria-label="Main" className="flex flex-col gap-px pt-1">
          <li>
            <Link
              to="/w/$tenantSlug"
              params={{ tenantSlug: tenant.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE, 'aria-current': 'page' }}
              activeOptions={{ exact: true }}
            >
              <RowContent icon={<HomeIcon />} label="Home" />
            </Link>
          </li>
          <li>
            <Link
              to="/w/$tenantSlug/search"
              params={{ tenantSlug: tenant.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE, 'aria-current': 'page' }}
            >
              <RowContent icon={<SearchIcon />} label="Search" />
            </Link>
          </li>
          <li>
            <Link
              to="/w/$tenantSlug/reviews"
              params={{ tenantSlug: tenant.slug }}
              className={ROW}
              activeProps={{ className: ROW_ACTIVE, 'aria-current': 'page' }}
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
                activeProps={{ className: ROW_ACTIVE, 'aria-current': 'page' }}
              >
                <RowContent icon={<SettingsIcon />} label="Settings & members" />
              </Link>
            </li>
          )}
        </ul>
        {/* Keyed by workspace: another workspace starts from its own remembered state, not this one's. */}
        <SpacesSection key={tenant.id} />
      </nav>

      <UploadPanel />
      <AccountRow />
    </div>
  );
}
