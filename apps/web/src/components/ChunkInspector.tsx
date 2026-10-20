import { useId, useState } from 'react';
import { chunkSummary } from '../lib/chunks.js';
import { headingLine } from '../lib/search.js';
import { useVersionChunks } from '../lib/queries.js';
import { Button, ErrorNote, Loading } from './ui.js';

/**
 * How a file version is (or would be) cut for search: the chunks with their heading and pages,
 * in plain text. Editors only (the API refuses everyone else), and fetched when first opened.
 */
export function ChunkInspector({ versionId }: { versionId: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { data, error, isPending } = useVersionChunks(versionId, open);

  return (
    <section className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide search chunks' : 'Show search chunks'}
      </Button>
      <div id={panel} hidden={!open} className="flex flex-col gap-3">
        {open &&
          (error ? (
            <ErrorNote error={error} />
          ) : isPending ? (
            <Loading what="chunks" />
          ) : !data.ready ? (
            <p className="text-sm text-muted">The text is still being read.</p>
          ) : (
            <>
              <p className="text-sm text-muted">
                {data.indexed ? 'Indexed' : 'Not indexed yet — this is how the text would be cut'}
                {data.pageCount !== null && ` · ${data.pageCount} ${data.pageCount === 1 ? 'page' : 'pages'}`}
                {` · ${data.chunks.length} ${data.chunks.length === 1 ? 'chunk' : 'chunks'}`}
                {data.ocrUsed && ' · Text read with OCR'}
              </p>
              <ol aria-label="Chunks" className="flex flex-col gap-3">
                {data.chunks.map((c) => (
                  <li key={c.ordinal} className="rounded-md border border-line bg-surface p-3">
                    <p className="text-xs font-medium text-muted">
                      Chunk {c.ordinal + 1} · {chunkSummary(c)}
                    </p>
                    {c.headingPath.length > 0 && <p className="text-xs text-muted">{headingLine(c.headingPath)}</p>}
                    <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm">{c.text}</pre>
                  </li>
                ))}
              </ol>
            </>
          ))}
      </div>
    </section>
  );
}
