import { useRef, useState, type KeyboardEvent } from 'react';
import type { ChunkInspector, FileDetails, SpaceResponse, SpaceRole } from '@kinote/contracts';
import { chunkSummary } from '../lib/chunks.js';
import { fileType } from '../lib/fileType.js';
import { formatBytes } from '../lib/fileUi.js';
import { versionWho, whenLabel } from '../lib/history.js';
import { useFileVersions } from '../lib/queries.js';
import { headingLine } from '../lib/search.js';
import { loadSession } from '../lib/session.js';
import type { FileControls } from '../lib/fileUi.js';
import { FileVersions } from './FileVersions.js';
import { ErrorNote, Loading } from './ui.js';

type Tab = 'details' | 'chunks' | 'versions';

const ROW = 'flex flex-col gap-0.5 border-b border-line py-2 last:border-0';

/**
 * The file's right rail: Details, the chunks search will see, and the
 * versions. The same content is a column at 1200 and up and a sheet below.
 */
export function FileRail({
  file,
  shownId,
  role,
  space,
  controls,
  chunks,
  chunksError,
  chunksPending,
  onLoadChunks,
  onClose,
}: {
  file: FileDetails;
  shownId: string | null;
  role: SpaceRole | null;
  space: SpaceResponse | undefined;
  controls: FileControls;
  chunks: ChunkInspector | undefined;
  chunksError: unknown;
  chunksPending: boolean;
  onLoadChunks: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('details');
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ details: null, chunks: null, versions: null });
  const selfId = loadSession()?.user.id ?? null;
  const { data: versions } = useFileVersions(file.id);
  const latest = versions?.[0];
  const who = latest ? versionWho(latest, selfId) : null;
  const type = fileType(file.title, latest?.mimeType);
  const indexed = file.indexedVersion;
  const orderedTabs: Tab[] = controls.chunks ? ['details', 'chunks', 'versions'] : ['details', 'versions'];

  const counts: Record<Tab, string> = {
    details: 'Details',
    chunks: chunks ? `Chunks (${chunks.chunks.length})` : 'Chunks',
    versions: versions ? `Versions (${versions.length})` : 'Versions',
  };

  function onTabKey(event: KeyboardEvent, current: Tab) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = orderedTabs.indexOf(current);
    const next =
      event.key === 'Home'
        ? orderedTabs[0]!
        : event.key === 'End'
          ? orderedTabs[orderedTabs.length - 1]!
          : orderedTabs[(index + (event.key === 'ArrowRight' ? 1 : orderedTabs.length - 1)) % orderedTabs.length]!;
    setTab(next);
    tabs.current[next]?.focus();
  }

  return (
    <aside aria-label="File information" className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">File</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file information"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
        >
          Close
        </button>
      </div>

      <div role="tablist" aria-label="File information views" className="flex gap-1 border-b border-line">
        {orderedTabs.map((value) => (
          <button
            key={value}
            ref={(element) => {
              tabs.current[value] = element;
            }}
            type="button"
            role="tab"
            id={`file-rail-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={tab === value ? `file-rail-${value}` : undefined}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              setTab(value);
              if (value === 'chunks') onLoadChunks();
            }}
            onKeyDown={(event) => {
              onTabKey(event, value);
              if ((event.key === 'ArrowRight' || event.key === 'End') && controls.chunks) onLoadChunks();
            }}
            className={`-mb-px border-b-2 px-2 py-2 text-xs font-medium max-md:min-h-11 ${
              tab === value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {counts[value]}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <div role="tabpanel" id="file-rail-details" aria-labelledby="file-rail-details-tab" className="flex flex-col gap-1 text-xs">
          <dl className="flex flex-col">
            <div className={ROW}>
              <dt className="text-muted">Type</dt>
              <dd>{type.label}</dd>
            </div>
            {latest && (
              <div className={ROW}>
                <dt className="text-muted">Size</dt>
                <dd>{formatBytes(latest.sizeBytes)}</dd>
              </div>
            )}
            {latest && who && (
              <div className={ROW}>
                <dt className="text-muted">Uploaded</dt>
                <dd>
                  {who.name} · <time dateTime={latest.createdAt}>{whenLabel(latest.createdAt)}</time>
                </dd>
              </div>
            )}
            {indexed && (
              <div className={ROW}>
                <dt className="text-muted">Indexed version</dt>
                <dd>
                  v{indexed.number} ·{' '}
                  <time dateTime={indexed.indexedAt ?? indexed.createdAt}>
                    {whenLabel(indexed.indexedAt ?? indexed.createdAt)}
                  </time>
                </dd>
              </div>
            )}
            {chunks?.pageCount !== null && chunks?.pageCount !== undefined && (
              <div className={ROW}>
                <dt className="text-muted">Pages</dt>
                <dd>{chunks.pageCount}</dd>
              </div>
            )}
            {chunks && (
              <div className={ROW}>
                <dt className="text-muted">Chunks</dt>
                <dd>{chunks.chunks.length}</dd>
              </div>
            )}
            {space && (
              <div className={ROW}>
                <dt className="text-muted">Space</dt>
                <dd>{space.name}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {tab === 'chunks' && controls.chunks && (
        <div role="tabpanel" id="file-rail-chunks" aria-labelledby="file-rail-chunks-tab" className="flex flex-col gap-3">
          {chunksError ? (
            <ErrorNote error={chunksError} />
          ) : chunksPending ? (
            <Loading what="chunks" />
          ) : !chunks ? null : !chunks.ready ? (
            <p className="text-xs text-muted">The text is still being read.</p>
          ) : chunks.chunks.length === 0 ? (
            <p className="text-xs text-muted">Not indexed yet</p>
          ) : (
            <>
              <p className="text-xs text-muted">
                {chunks.indexed ? 'Indexed · ' : 'Not indexed yet · '}
                {chunks.chunks.length} chunks
                {chunks.pageCount !== null && ` · ${chunks.pageCount} pages`}
                {' · text read from the file'}
              </p>
              <ol aria-label="Chunks" className="flex flex-col gap-2">
                {chunks.chunks.map((chunk) => (
                  <li key={chunk.ordinal} className="rounded-md border border-line bg-surface p-2">
                    <p className="text-[10px] font-medium text-muted">
                      <span className="font-mono">{String(chunk.ordinal + 1).padStart(2, '0')}</span> · {chunkSummary(chunk)}
                    </p>
                    {chunk.headingPath.length > 0 && <p className="text-[10px] text-muted">{headingLine(chunk.headingPath)}</p>}
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs">{chunk.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}

      {tab === 'versions' && (
        <div role="tabpanel" id="file-rail-versions" aria-labelledby="file-rail-versions-tab">
          <FileVersions fileId={file.id} role={role} shownId={shownId} />
        </div>
      )}
    </aside>
  );
}
