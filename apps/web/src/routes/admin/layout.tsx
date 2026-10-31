import { Link, Outlet } from '@tanstack/react-router';
import { adminScreens } from '../../lib/console.js';
import { useWorkspace } from '../../lib/queries.js';
import { AppTopBar } from '../../components/AppTopBar.js';
import { Card } from '../../components/ui.js';

/** `/w/$tenantSlug/admin`: the Settings frame: top bar, one line about the workspace, and underline tabs. */
export function AdminLayout() {
  const { tenant, role } = useWorkspace();
  const screens = adminScreens(role);

  if (screens.length === 0) {
    return (
      <>
        <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Settings</span>} />
        <Card title="You don't have access">
          <p className="text-sm text-fg">
            Only owners and admins of this workspace can manage members, groups, spaces and sources. Ask an owner or admin if you
            need a change.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Settings</span>} />
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-[21px] font-semibold tracking-tight text-fg md:text-2xl">Settings</h1>
          <p className="text-sm text-muted">People, access and sources for {tenant.name}.</p>
        </header>
        <nav aria-label="Settings" className="flex gap-5 overflow-x-auto border-b border-line">
          {screens.map((screen) => (
            <Link
              key={screen.to}
              to={screen.to}
              params={{ tenantSlug: tenant.slug }}
              className="-mb-px shrink-0 border-b-2 border-transparent px-1 py-2.5 text-sm font-medium text-muted hover:text-fg max-md:min-h-11"
              activeProps={{ className: '-mb-px shrink-0 border-b-2 border-accent px-1 py-2.5 text-sm font-medium text-fg max-md:min-h-11', 'aria-current': 'page' }}
            >
              {screen.label}
            </Link>
          ))}
        </nav>
        <Outlet />
      </div>
    </>
  );
}
