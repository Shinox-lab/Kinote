import type { ReactNode } from 'react';
import type { PageDetails } from '@living-wiki/contracts';
import { PageIconPicker } from './PageIconPicker.js';

/**
 * The document's identity: the emoji, the title at 34/600, and a slot for the
 * status/meta row. The top bar keeps the breadcrumb and the page menu.
 */
export function PageHeader({
  page,
  canEdit,
  meta,
}: {
  page: PageDetails;
  canEdit: boolean;
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <PageIconPicker pageId={page.id} icon={page.icon} canEdit={canEdit} />
      <h1 className="break-words text-[2.125rem] font-semibold leading-[1.12] tracking-[-0.024em] text-fg">
        {page.title}
      </h1>
      {meta}
    </header>
  );
}
