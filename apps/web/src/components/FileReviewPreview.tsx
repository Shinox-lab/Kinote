import { useId, useState } from 'react';
import { previewLines } from '../lib/chunks.js';
import { useVersionChunks } from '../lib/queries.js';
import { Button, ErrorNote, Loading } from './ui.js';

/** The first lines of the text read from a file waiting for review, fetched when first opened. */
export function FileReviewPreview({ versionId, title }: { versionId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { data, error, isPending } = useVersionChunks(versionId, open);

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide text' : 'Show text'}
      </Button>
      <div id={panel} hidden={!open}>
        {open &&
          (error ? (
            <ErrorNote error={error} />
          ) : isPending ? (
            <Loading what="text" />
          ) : !data.ready ? (
            <p className="text-sm text-muted">The text is still being read.</p>
          ) : (
            <Lines title={title} data={data} />
          ))}
      </div>
    </div>
  );
}

function Lines({ title, data }: { title: string; data: NonNullable<ReturnType<typeof useVersionChunks>['data']> }) {
  const { lines, truncated } = previewLines(data.sections);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        {data.pageCount !== null && `${data.pageCount} ${data.pageCount === 1 ? 'page' : 'pages'} · `}
        {data.chunks.length} {data.chunks.length === 1 ? 'chunk' : 'chunks'} when indexed
        {data.ocrUsed && ' · Text read with OCR'}
      </p>
      {lines.length === 0 ? (
        <p className="text-sm text-muted">No text was found in this file.</p>
      ) : (
        <ul aria-label={`Text of ${title}`} className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3 text-sm">
          {lines.map((line, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="text-xs text-muted">Only the first lines are shown.</p>}
    </div>
  );
}
