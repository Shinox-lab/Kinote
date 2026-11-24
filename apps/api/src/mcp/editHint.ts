import type { DocumentRow } from '@kinote/db';
import type { VersionRow } from '@kinote/core';

/**
 * The last header line of every `kinote_read`: how this page or file changes. One function, so a file type
 * that gets its own editor (the xlsx editor) adds its line here.
 */
export function editHintFor(
  doc: Pick<DocumentRow, 'kind' | 'placement'>,
  role: 'viewer' | 'editor',
  current: Pick<VersionRow, 'number'> | null,
  sourceName: string | null
): string {
  if (doc.kind === 'page') return 'Edit with: kinote_edit';
  if (doc.placement === 'synced') return `Managed by ${sourceName ?? 'its source'}: change it at the source.`;
  if (role === 'viewer') return 'View only: a person with edit access can change it.';
  return current
    ? `Edit with: kinote_download, then kinote_replace (base_version ${current.number})`
    : 'Edit with: kinote_download, then kinote_replace';
}
