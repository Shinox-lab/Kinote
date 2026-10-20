import type { ReactNode } from 'react';
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
  children: ReactNode;
}) {
  const activeProps = activeClassName ? { className: activeClassName } : undefined;
  if (kind === 'page') {
    return (
      <Link to="/w/$tenantSlug/p/$pageId" params={{ tenantSlug, pageId: id }} className={className} activeProps={activeProps}>
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
    >
      {children}
    </Link>
  );
}
