import { Link, Outlet } from '@tanstack/react-router';
import { adminScreens } from '../../lib/console.js';
import { useWorkspace } from '../../lib/queries.js';
import { Card } from '../../components/ui.js';

const TAB = 'rounded-md px-3 py-1.5 text-sm font-medium text-fg hover:bg-hover';

/** `/w/$tenantSlug/admin`: tabs for the admin screens, or a plain "no access" state for other roles. */
export function AdminLayout() {
  const { tenant, role } = useWorkspace();
  const screens = adminScreens(role);

  if (screens.length === 0) {
    return (
      <Card title="You don't have access">
        <p className="text-sm text-fg">
          Only owners and admins of this workspace can manage members, groups, spaces and sources. Ask an owner or admin if you
          need a change.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">Administration</h1>
      <nav aria-label="Administration" className="flex gap-1 border-b border-line pb-2">
        {screens.map((screen) => (
          <Link
            key={screen.to}
            to={screen.to}
            params={{ tenantSlug: tenant.slug }}
            className={TAB}
            activeProps={{ className: `${TAB} bg-active` }}
          >
            {screen.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
