import { Link } from '@tanstack/react-router';
import type { TreeItem } from '../lib/wiki.js';

function Items({ items, tenantSlug }: { items: TreeItem[]; tenantSlug: string }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(({ node, children }) => (
        <li key={node.id}>
          {node.kind === 'page' ? (
            <Link
              to="/w/$tenantSlug/p/$pageId"
              params={{ tenantSlug, pageId: node.id }}
              className="rounded px-1 text-sm font-medium text-accent-text hover:underline"
            >
              {node.title}
            </Link>
          ) : (
            <span className="px-1 text-sm text-fg">
              {node.title} <span className="text-xs text-muted">(file)</span>
            </span>
          )}
          {children.length > 0 && (
            <div className="ml-3 mt-1 border-l border-line pl-3">
              <Items items={children} tenantSlug={tenantSlug} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The pages of a space, nested by parent; each page links to its editor. */
export function Tree({ items, tenantSlug, label }: { items: TreeItem[]; tenantSlug: string; label: string }) {
  return (
    <nav aria-label={label}>
      <Items items={items} tenantSlug={tenantSlug} />
    </nav>
  );
}
