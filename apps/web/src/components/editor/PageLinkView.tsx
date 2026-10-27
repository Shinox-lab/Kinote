import { useNavigate } from '@tanstack/react-router';
import { documentHref } from '../../lib/documentLink.js';
import { useDocumentTitle, useWorkspace } from '../../lib/queries.js';
import { usePeek } from '../../lib/usePeek.js';

/**
 * A page link inside the editor: the target's current title (it follows
 * renames). A target the reader can't open, or one that is archived, reads
 * "Page unavailable" once the server says so, rather than the title stored in
 * the link. A click
 * opens the side panel; Cmd/Ctrl-click or a middle click opens the full page.
 * A link to a file (pasted by id) opens the file's screen.
 */
export function PageLinkView({ documentId, title }: { documentId: string; title: string }) {
  const { tenant } = useWorkspace();
  const peek = usePeek();
  const navigate = useNavigate();
  const { data, isPending } = useDocumentTitle(documentId);
  const unavailable = !isPending && !data;
  const label = unavailable ? 'Page unavailable' : (data?.title ?? title) || 'Untitled';
  return (
    <a
      href={unavailable ? undefined : documentHref(tenant.slug, data?.kind ?? 'page', documentId)}
      data-page-link={documentId}
      data-unavailable={unavailable || undefined}
      className={`page-link ${unavailable ? 'page-link-unavailable' : ''}`}
      title={unavailable ? undefined : label}
      onClick={(e) => {
        if (unavailable) {
          e.preventDefault();
          return;
        }
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        if (data?.kind === 'file') void navigate({ href: documentHref(tenant.slug, 'file', documentId) });
        else peek.open(documentId);
      }}
    >
      {data?.icon && <span aria-hidden="true">{data.icon} </span>}
      {label}
    </a>
  );
}
