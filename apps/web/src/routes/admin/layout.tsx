import { useRef } from 'react';
import { Link, Outlet, useRouter } from '@tanstack/react-router';
import { adminScreens } from '../../lib/console.js';
import { useWorkspace } from '../../lib/queries.js';
import { settingsReturnTarget } from '../../lib/settingsReturn.js';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { CloseIcon } from '../../components/icons.js';

/**
 * `/w/$tenantSlug/admin`: Settings as a pop-out panel over the app: a title, underline tabs and the screen
 * in a scrolling body. Closing returns to the screen it opened over.
 */
export function AdminLayout() {
  const { tenant, role } = useWorkspace();
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const screens = adminScreens(role);

  function close() {
    router.history.push(settingsReturnTarget(`/w/${encodeURIComponent(tenant.slug)}`));
  }

  // A dialog opened from inside the panel (a new token, say) takes Escape first.
  useFocusTrap(panel, true, () => {
    const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    if (dialogs.length <= 1) close();
  });

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-overlay md:items-center md:p-6" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-[960px] flex-col bg-surface shadow-pop md:h-[min(86vh,780px)] md:rounded-xl md:border md:border-line"
      >
        <header className="flex items-start gap-3 px-5 pt-4 md:px-6">
          <div className="min-w-0 flex-1">
            <h1 id="settings-title" className="text-[19px] font-semibold tracking-tight text-fg">
              Settings &amp; members
            </h1>
            <p className="truncate text-sm text-muted">People, access, sources and usage for {tenant.name}.</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover max-md:size-11"
          >
            <CloseIcon />
          </button>
        </header>

        {screens.length === 0 ? (
          <div className="px-5 py-6 md:px-6">
            <h2 className="text-base font-semibold text-fg">You don&apos;t have access</h2>
            <p className="mt-1 text-sm text-fg">
              Only owners and admins of this workspace can manage members, groups, spaces and sources, or see its usage. Ask an owner or admin if
              you need a change.
            </p>
          </div>
        ) : (
          <>
            <nav aria-label="Settings" className="mx-5 mt-3 flex shrink-0 gap-5 overflow-x-auto border-b border-line md:mx-6">
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
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-6">
              <Outlet />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
