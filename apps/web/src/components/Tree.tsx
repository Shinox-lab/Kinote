import { DocumentLink } from './DocumentLink.js';
import type { TreeItem } from '../lib/wiki.js';

function Items({ items, tenantSlug }: { items: TreeItem[]; tenantSlug: string }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(({ node, children }) => (
        <li key={node.id}>
          <DocumentLink
            tenantSlug={tenantSlug}
            kind={node.kind}
            id={node.id}
            className="rounded px-1 text-sm font-medium text-accent-text hover:underline"
          >
            {node.title}
          </DocumentLink>
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
