import {
  Link,
  Outlet,
  lazyRouteComponent,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { api, isUnauthenticated } from './lib/api.js';
import { pickWorkspace, safeRedirect } from './lib/console.js';
import { ME_KEY } from './lib/queries.js';
import { endSession, queryClient, setUnauthenticatedHandler } from './lib/queryClient.js';
import { loadSession, saveSession, type Session } from './lib/session.js';
import { ErrorFallback } from './components/ErrorBoundary.js';
import { AcceptInvitePage } from './routes/accept-invite.js';
import { AdminLayout } from './routes/admin/layout.js';
import { GroupsPage } from './routes/admin/groups.js';
import { MembersPage } from './routes/admin/members.js';
import { SpacesPage } from './routes/admin/spaces.js';
import { parseFileSearch } from './lib/documentLink.js';
import { parseReviewSearch } from './lib/review.js';
import { parseSearchSearch } from './lib/search.js';
import { parsePeekSearch } from './lib/links.js';
import { parseCommentsSearch } from './lib/comments.js';
import { WorkspaceLayout } from './routes/layout.js';
import { ReviewsPage } from './routes/reviews.js';
import { NotificationsPage } from './routes/notifications.js';
import { CapturePage } from './routes/capture.js';
import { parseCaptureSearch, parsePageCaptureSearch } from './lib/capture.js';
import { SearchPage } from './routes/search.js';
import { SignInPage } from './routes/sign-in.js';
import { SignUpPage } from './routes/sign-up.js';
import { SpacePage } from './routes/space.js';
import { WorkspaceHomePage } from './routes/workspace-home.js';
import { CreateWorkspacePage } from './routes/workspaces.js';

// Code-based route tree. Unauthenticated visitors go to /sign-in (and come back
// afterwards); /w/$tenantSlug resolves the workspace from the URL and pins it in
// the session so every API call carries its x-tenant-id.

/** The signed-in session, or a redirect to /sign-in that remembers where the visitor was going. */
function requireSession(href: string): Session {
  const session = loadSession();
  if (!session) {
    const target = safeRedirect(href);
    throw redirect({ to: '/sign-in', search: { redirect: target === '/' ? undefined : target } });
  }
  return session;
}

/** The user's memberships; a rejected session ends here with a redirect to /sign-in. */
async function loadMe(staleTime: number) {
  try {
    return await queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: () => api.me(), staleTime });
  } catch (err) {
    if (isUnauthenticated(err)) {
      endSession();
      throw redirect({ to: '/sign-in', search: { redirect: undefined } });
    }
    throw err;
  }
}

/** Only a string search value is a redirect target; the router keeps the rest out. */
const validateRedirectSearch = (search: Record<string, unknown>): { redirect?: string } =>
  typeof search.redirect === 'string' ? { redirect: search.redirect } : {};

function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-2 text-xl font-semibold">Page not found</h1>
      <Link to="/" className="text-sm font-medium text-accent-text underline">
        Go to your workspace
      </Link>
    </main>
  );
}

const rootRoute = createRootRoute({ component: Outlet });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: validateRedirectSearch,
  beforeLoad: () => {
    if (loadSession()) throw redirect({ to: '/' });
  },
  component: SignInPage,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  validateSearch: validateRedirectSearch,
  beforeLoad: () => {
    if (loadSession()) throw redirect({ to: '/' });
  },
  component: SignUpPage,
});

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite/$token',
  beforeLoad: ({ location }) => {
    requireSession(location.href);
  },
  component: AcceptInvitePage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const session = requireSession('/');
    const me = await loadMe(0);
    const first = pickWorkspace(me.memberships, session.tenantSlug);
    if (first) throw redirect({ to: '/w/$tenantSlug', params: { tenantSlug: first.tenant.slug } });
  },
  component: CreateWorkspacePage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$tenantSlug',
  // Any workspace screen can show a page in the side panel.
  validateSearch: parsePeekSearch,
  beforeLoad: async ({ params, location }) => {
    const session = requireSession(location.href);
    const me = await loadMe(30_000);
    const membership = me.memberships.find((m) => m.tenant.slug === params.tenantSlug);
    if (!membership) throw redirect({ to: '/' });
    saveSession({ ...session, tenantId: membership.tenant.id, tenantSlug: membership.tenant.slug });
    return { tenant: membership.tenant, role: membership.role };
  },
  component: WorkspaceLayout,
});

const workspaceHomeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: WorkspaceHomePage,
});

const spaceRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 's/$spaceSlug',
  component: SpacePage,
});

const pageRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'p/$pageId',
  validateSearch: (search: Record<string, unknown>) => ({ ...parsePageCaptureSearch(search), ...parseCommentsSearch(search) }),
  // The editor and its dependencies are heavy: load them only when a page is opened.
  component: lazyRouteComponent(() => import('./routes/page.js'), 'PagePage'),
});

const fileRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'f/$fileId',
  validateSearch: parseFileSearch,
  // The file screen, its viewers and their libraries load only when a file is opened.
  component: lazyRouteComponent(() => import('./routes/file.js'), 'FilePage'),
});

const reviewsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'reviews',
  validateSearch: parseReviewSearch,
  component: ReviewsPage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'notifications',
  component: NotificationsPage,
});

const captureRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'capture',
  validateSearch: parseCaptureSearch,
  component: CapturePage,
});

const searchRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'search',
  validateSearch: parseSearchSearch,
  component: SearchPage,
});

const adminRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'admin',
  component: AdminLayout,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/w/$tenantSlug/admin/members', params });
  },
});

const membersRoute = createRoute({ getParentRoute: () => adminRoute, path: 'members', component: MembersPage });
const groupsRoute = createRoute({ getParentRoute: () => adminRoute, path: 'groups', component: GroupsPage });
const spacesRoute = createRoute({ getParentRoute: () => adminRoute, path: 'spaces', component: SpacesPage });
const sourcesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'sources',
  // Rarely opened: its code loads when it is.
  component: lazyRouteComponent(() => import('./routes/admin/sources.js'), 'SourcesPage'),
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  signUpRoute,
  acceptInviteRoute,
  indexRoute,
  workspaceRoute.addChildren([
    workspaceHomeRoute,
    spaceRoute,
    pageRoute,
    fileRoute,
    reviewsRoute,
    notificationsRoute,
    captureRoute,
    searchRoute,
    adminRoute.addChildren([adminIndexRoute, membersRoute, groupsRoute, spacesRoute, sourcesRoute]),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: ({ error, reset }) => <ErrorFallback error={error} onRetry={reset} />,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// A rejected token anywhere (a query, a mutation) lands here after the session is cleared.
setUnauthenticatedHandler(() => {
  void router.navigate({ to: '/sign-in', search: { redirect: undefined } });
});
