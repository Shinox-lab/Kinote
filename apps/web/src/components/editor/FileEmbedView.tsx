import { useNavigate } from '@tanstack/react-router';
import type { FileDetails, FileVersion } from '@kinote/contracts';
import { documentHref } from '../../lib/documentLink.js';
import { formatBytes, publishedVersionId } from '../../lib/fileUi.js';
import { useFile, useSpaces, useWorkspace } from '../../lib/queries.js';
import { inlineViewerFor } from '../../lib/viewers.js';
import { FileTypeTile } from '../FileTypeTile.js';
import { FileViewer } from '../../viewers/FileViewer.js';

/**
 * The header of an embedded file: the type tile, the current title and size,
 * and a link to the file's own screen. The title follows renames because it is
 * read from the file document, not copied into the block.
 */
function EmbedHeader({
  file,
  version,
  name,
  border,
}: {
  file: FileDetails | undefined;
  version: FileVersion | null;
  name: string;
  border?: boolean;
}) {
  const { tenant } = useWorkspace();
  const navigate = useNavigate();
  const title = file?.title ?? name ?? 'File';
  const href = file ? documentHref(tenant.slug, 'file', file.id) : undefined;
  return (
    <a
      href={href}
      className={`flex min-w-0 items-center gap-3 p-3 ${border ? 'border-b border-line' : ''} ${
        href ? 'hover:bg-hover' : ''
      }`}
      onClick={(e) => {
        if (!href || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        void navigate({ href });
      }}
    >
      <FileTypeTile name={title} mimeType={version?.mimeType} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{title}</span>
        {version && <span className="block truncate text-xs text-muted">{formatBytes(version.sizeBytes)}</span>}
      </span>
      {href && <span className="shrink-0 text-xs text-muted">Open</span>}
    </a>
  );
}

/**
 * A file pasted into a page. Pictures, plain text and Markdown show a capped
 * preview; every other format is a compact card. The block always points at
 * the file document, so it opens the normal file screen and follows renames,
 * versions and access checks.
 */
export function FileEmbedView({ documentId, name, error }: { documentId: string; name: string; error: string }) {
  const { data: spaces = [] } = useSpaces();
  const { data: file, error: loadError, isPending } = useFile(documentId || undefined);

  if (!documentId) {
    return (
      <div className="my-2 flex items-center gap-3 rounded-lg border border-line bg-surface p-3" data-file-embed>
        <FileTypeTile name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{name || 'File'}</p>
          <p className={`text-xs ${error ? 'text-danger' : 'text-muted'}`}>{error || 'Uploading…'}</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="my-2 flex items-center gap-3 rounded-lg border border-line bg-surface p-3" data-file-embed>
        <FileTypeTile name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{name || 'File'}</p>
          <p className="text-xs text-muted">File unavailable</p>
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="my-2 flex items-center gap-3 rounded-lg border border-line bg-surface p-3" data-file-embed>
        <FileTypeTile name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{name || 'File'}</p>
          <p className="text-xs text-muted">{isPending ? 'Loading file…' : 'File unavailable'}</p>
        </div>
      </div>
    );
  }

  const role = spaces.find((s) => s.id === file.spaceId)?.myRole ?? null;
  const shown = publishedVersionId(file, role);
  const version = [file.latestVersion, file.indexedVersion].find((v) => v?.id === shown) ?? null;
  const preview = version ? inlineViewerFor(version.mimeType, version.sizeBytes) : null;

  if (!version) {
    return (
      <div className="my-2 flex items-center gap-3 rounded-lg border border-line bg-surface p-3" data-file-embed>
        <FileTypeTile name={file.title} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{file.title}</p>
          <p className="text-xs text-muted">Nothing published yet</p>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="my-2 rounded-lg border border-line bg-surface" data-file-embed>
        <EmbedHeader file={file} version={version} name={name} />
      </div>
    );
  }

  return (
    <figure className="my-2 overflow-hidden rounded-lg border border-line bg-surface" data-file-embed>
      <EmbedHeader file={file} version={version} name={name} border />
      <div className="max-h-80 overflow-auto bg-page">
        <FileViewer version={version} />
      </div>
    </figure>
  );
}
