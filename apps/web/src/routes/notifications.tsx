import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Notification } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { notificationHeadline, notificationTarget } from '../lib/notifications.js';
import { useNotifications, useRefresh, useWorkspace } from '../lib/queries.js';
import { relativeTime } from '../lib/updates.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { Button, ErrorNote, Loading } from '../components/ui.js';

function ago(iso: string): string {
  const value = relativeTime(iso, new Date());
  return /^\d/.test(value) ? `${value} ago` : value;
}

/** `/w/$tenantSlug/notifications`: what people asked of you, newest first; opening one marks it read. */
export function NotificationsPage() {
  const { tenant } = useWorkspace();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const { data, error, isPending } = useNotifications();
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => void refresh('notifications'),
  });

  const open = (n: Notification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    void navigate({ href: notificationTarget(n, tenant.slug).href });
  };

  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Notifications</span>} />
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold text-fg">Notifications</h1>
          {(data?.unread ?? 0) > 0 && (
            <Button variant="secondary" disabled={markRead.isPending} onClick={() => markRead.mutate(undefined)}>
              Mark all read
            </Button>
          )}
        </header>
        <ErrorNote error={error ?? markRead.error} />
        {isPending ? (
          <Loading what="notifications" />
        ) : !data || data.items.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet. Mentions, replies to your comments and reviews show up here.</p>
        ) : (
          <ul aria-label="Notifications" className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
            {data.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover max-md:min-h-11"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={`text-sm ${n.readAt ? 'text-muted' : 'font-medium text-fg'}`}>
                      {notificationHeadline(n)}
                      {!n.readAt && <span className="sr-only"> (unread)</span>}
                    </span>
                    {n.excerpt && <span className="line-clamp-2 text-xs text-muted">{n.excerpt}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{ago(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
