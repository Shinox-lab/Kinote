import { Link } from '@tanstack/react-router';
import type { PageConnections as Connections } from '@kinote/contracts';
import { documentHref } from '../lib/documentLink.js';
import { connectionCount } from '../lib/links.js';
import { usePageConnections, useWorkspace } from '../lib/queries.js';
import { usePeek } from '../lib/usePeek.js';

const ROW = 'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover max-md:min-h-11';

function PageName({ icon, title }: { icon: string | null; title: string }) {
  return (
    <span className="min-w-0 truncate text-sm font-medium text-fg">
      {icon && <span aria-hidden="true">{icon} </span>}
      {title}
    </span>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="px-2 text-xs font-medium text-muted">{label}</h3>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

/** A row that opens its page in the side panel; Cmd/Ctrl-click or a middle click opens the full page. */
function PeekRow({ pageId, children }: { pageId: string; children: React.ReactNode }) {
  const { tenant } = useWorkspace();
  const peek = usePeek();
  return (
    <a
      href={documentHref(tenant.slug, 'page', pageId)}
      className={ROW}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        peek.open(pageId);
      }}
    >
      {children}
    </a>
  );
}

/** The sections of a page's connections, given what the API returned. */
export function ConnectionsList({ connections }: { connections: Connections }) {
  const { tenant } = useWorkspace();
  const { linkedFrom, updatedBy, updated } = connections;
  return (
    <div className="flex flex-col gap-3">
      {updated.length > 0 && (
        <Group label="Updated from this page">
          {updated.map((u) => (
            <li key={`${u.pageId}:${u.captureId}`}>
              {/* The full page, in "changes from this capture" mode, shows exactly what this page changed there. */}
              <Link
                to="/w/$tenantSlug/p/$pageId"
                params={{ tenantSlug: tenant.slug, pageId: u.pageId }}
                search={{ capture: u.captureId }}
                className={ROW}
              >
                <PageName icon={u.icon} title={u.title} />
                <span className="text-xs text-muted">
                  {u.spaceName} · {u.sections} {u.sections === 1 ? 'section' : 'sections'} changed
                </span>
              </Link>
            </li>
          ))}
        </Group>
      )}
      {updatedBy.length > 0 && (
        <Group label="Updated by">
          {updatedBy.map((u) => (
            <li key={u.pageId}>
              <PeekRow pageId={u.pageId}>
                <PageName icon={u.icon} title={u.title} />
                <span className="text-xs text-muted">
                  {u.spaceName} · {u.blockIds.length} {u.blockIds.length === 1 ? 'section' : 'sections'} here
                </span>
              </PeekRow>
            </li>
          ))}
        </Group>
      )}
      {linkedFrom.length > 0 && (
        <Group label="Linked from">
          {linkedFrom.map((l) => (
            <li key={l.pageId}>
              <PeekRow pageId={l.pageId}>
                <PageName icon={l.icon} title={l.title} />
                <span className="line-clamp-2 text-xs text-muted">
                  {l.spaceName}
                  {l.excerpt && ` · ${l.excerpt}`}
                </span>
              </PeekRow>
            </li>
          ))}
        </Group>
      )}
    </div>
  );
}

/** The end of a page: the pages it connects to, collapsed when there are none. */
export function PageConnections({ pageId }: { pageId: string }) {
  const { data } = usePageConnections(pageId);
  if (!data || connectionCount(data) === 0) return null;
  const count = connectionCount(data);
  return (
    <section aria-label="Connections" className="mt-6 flex flex-col gap-2 border-t border-line pt-4">
      <h2 className="px-2 text-sm font-semibold text-fg">
        {count} connected {count === 1 ? 'page' : 'pages'}
      </h2>
      <ConnectionsList connections={data} />
    </section>
  );
}
