import { Link, Outlet, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { adminScreens } from '../lib/console.js';
import { useSpaces, useWorkspace } from '../lib/queries.js';
import { endSession } from '../lib/queryClient.js';
import { loadSession } from '../lib/session.js';
import { Button, ErrorNote, SelectField } from '../components/ui.js';

const NAV_LINK = 'rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100';

function SpaceSwitcher() {
  const { tenant } = useWorkspace();
  const { space } = useSearch({ from: '/w/$tenantSlug' });
  const navigate = useNavigate();
  const { data: spaces = [] } = useSpaces();
  const open = spaces.filter((s) => s.archivedAt === null);
  if (open.length === 0) return null;

  return (
    <div className="w-48">
      <SelectField
        compact
        label="Space"
        value={open.find((s) => s.slug === space)?.slug ?? open[0].slug}
        options={open.map((s) => ({ value: s.slug, label: s.name }))}
        onChange={(slug) =>
          void navigate({ to: '/w/$tenantSlug', params: { tenantSlug: tenant.slug }, search: { space: slug } })
        }
      />
    </div>
  );
}

/** The shell of `/w/$tenantSlug`: workspace name, space switcher, admin links, sign-out. */
export function WorkspaceLayout() {
  const { tenant, role } = useWorkspace();
  const router = useRouter();
  const user = loadSession()?.user;
  const screens = adminScreens(role);

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // Signed out here even when the server could not be told: the token is dropped either way.
    onSettled: () => {
      endSession();
      router.history.push('/sign-in');
    },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/w/$tenantSlug" params={{ tenantSlug: tenant.slug }} className="mr-2 text-base font-semibold">
            {tenant.name}
          </Link>
          <SpaceSwitcher />
          <nav aria-label="Workspace" className="flex flex-1 flex-wrap gap-1">
            {screens.length > 0 && (
              <Link
                to={screens[0].to}
                params={{ tenantSlug: tenant.slug }}
                className={NAV_LINK}
                activeProps={{ className: `${NAV_LINK} bg-slate-100` }}
              >
                Administration
              </Link>
            )}
          </nav>
          <span className="text-sm text-slate-600">{user?.name}</span>
          <Button variant="secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
