import type { DragEvent, MouseEvent, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

/**
 * A link to a page (its editor) or to a file (its own screen). Every list that
 * can hold either goes through here, so a file never opens as "page not found".
 * `page` is the page, sheet or slide of a file to open on.
 */
export function DocumentLink({
  tenantSlug,
  kind,
  id,
  page,
  version,
  className,
  activeClassName,
  draggable,
  onDragStart,
  onContextMenu,
  children,
}: {
  tenantSlug: string;
  kind: 'page' | 'file';
  id: string;
  page?: number | null;
  version?: string;
  className?: string;
  /** Replaces `className` while the link's own address is the current one. */
  activeClassName?: string;
  /** The row can be dragged (the tree moves it). */
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLAnchorElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const activeProps = activeClassName ? { className: activeClassName } : undefined;
  const rest = { draggable, onDragStart, onContextMenu };
  if (kind === 'page') {
    return (
      <Link
        to="/w/$tenantSlug/p/$pageId"
        params={{ tenantSlug, pageId: id }}
        className={className}
        activeProps={activeProps}
        {...rest}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/w/$tenantSlug/f/$fileId"
      params={{ tenantSlug, fileId: id }}
      search={{ ...(typeof page === 'number' && Number.isInteger(page) && page > 0 ? { page } : {}), ...(version ? { v: version } : {}) }}
      className={className}
      activeProps={activeProps}
      {...rest}
    >
      {children}
    </Link>
  );
}
