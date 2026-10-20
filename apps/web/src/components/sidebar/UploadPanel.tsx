import { useState } from 'react';
import { useWorkspace } from '../../lib/queries.js';
import { statusLine } from '../../lib/uploadQueue.js';
import { useUploads } from '../../lib/useUploads.js';
import { ChevronDownIcon, ChevronRightIcon, FileIcon } from '../icons.js';
import { DocumentLink } from '../DocumentLink.js';

/** What the person has sent lately and what became of each file; hidden when there is nothing. */
export function UploadPanel() {
  const { tenant } = useWorkspace();
  const { uploads, retry, dismiss } = useUploads();
  const [open, setOpen] = useState(true);
  if (uploads.length === 0) return null;
  const active = uploads.filter((u) => u.status === 'waiting' || u.status === 'uploading' || u.status === 'reading').length;

  return (
    <section aria-label="Uploads" className="border-t border-line px-1 pt-2">
      <h2 className="pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 px-1 text-xs font-medium uppercase tracking-wide text-muted hover:text-fg"
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          Uploads
          <span className="ml-auto normal-case tracking-normal">{active > 0 ? `${active} in progress` : 'Finished'}</span>
        </button>
      </h2>
      {open && (
        <ul aria-live="polite" className="flex max-h-48 flex-col gap-1 overflow-y-auto pb-1">
          {uploads.map((u) => {
            const finished = u.status === 'done' || u.status === 'failed' || u.status === 'duplicate';
            return (
              <li key={u.id} className="flex items-start gap-2 rounded-md px-1 py-1 text-xs">
                <span className="mt-0.5 text-base text-muted">
                  <FileIcon />
                </span>
                <span className="min-w-0 flex-1">
                  {u.documentId && u.status !== 'failed' ? (
                    <DocumentLink
                      tenantSlug={tenant.slug}
                      kind="file"
                      id={u.documentId}
                      className="block truncate font-medium text-accent-text hover:underline"
                    >
                      {u.fileName}
                    </DocumentLink>
                  ) : (
                    <span className="block truncate font-medium">{u.fileName}</span>
                  )}
                  <span className={u.status === 'failed' ? 'text-danger' : 'text-muted'}>{statusLine(u)}</span>
                </span>
                {u.status === 'failed' && (
                  <button type="button" className="shrink-0 underline" onClick={() => retry(u.id)} aria-label={`Try ${u.fileName} again`}>
                    Try again
                  </button>
                )}
                {finished && (
                  <button type="button" className="shrink-0 text-muted underline" onClick={() => dismiss(u.id)} aria-label={`Dismiss ${u.fileName}`}>
                    Dismiss
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
