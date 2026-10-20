import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ZOOM_STEPS, clampPage, nextZoom, parsePageInput } from '../lib/pdfPages.js';
import { VIEWER_TIMEOUT_MS } from '../lib/viewers.js';
import { Loading } from '../components/ui.js';
import { openPdf } from './pdfOpen.js';

const TOOL = 'rounded-md border border-line bg-page px-2.5 py-1 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A PDF one page at a time, drawn to a canvas: only the page on screen is rendered, so a 500-page file
 * costs the same as a 5-page one. No text layer and no annotations are drawn, and the file's own
 * JavaScript never runs; the library (v6) has no eval path (pinned in lazyViewers.test.ts).
 */
export default function PdfViewer({ bytes, page }: { bytes: ArrayBuffer; page?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [typed, setTyped] = useState('1');
  const count = doc?.numPages ?? 0;

  // Open the document (in pdf.js's own worker). The worker takes ownership of the buffer it is given, so it gets a copy.
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> | void } | null = null;
    openPdf<PDFDocumentProxy>(
      async () => {
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return () =>
          pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), disableAutoFetch: true, useSystemFonts: false });
      },
      () => cancelled,
      VIEWER_TIMEOUT_MS,
      (t) => (task = t)
    )
      .then((opened) => {
        if (!opened) return;
        setDoc(opened);
        setCurrent(clampPage(page, opened.numPages));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // `page` only picks where to start; moving to another page is the next effect's job.
  }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link that names another page of the same file moves there.
  useEffect(() => {
    if (doc) setCurrent(clampPage(page, doc.numPages));
  }, [page, doc]);
  useEffect(() => setTyped(String(current)), [current]);

  // Draw the page on screen.
  useEffect(() => {
    if (!doc || !canvas.current) return;
    const target = canvas.current;
    let cancelled = false;
    let render: { cancel: () => void } | null = null;
    (async () => {
      const pdfPage = await doc.getPage(current);
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: zoom * ratio });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      target.style.width = `${Math.floor(viewport.width / ratio)}px`;
      target.style.height = `${Math.floor(viewport.height / ratio)}px`;
      const task = pdfPage.render({ canvas: target, viewport, annotationMode: 0 });
      render = task;
      await task.promise;
    })().catch((err: unknown) => {
      // A render cancelled by moving on is normal; anything else means this page cannot be drawn.
      if (!cancelled && !(err instanceof Error && err.name === 'RenderingCancelledException')) setFailed(true);
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, current, zoom]);

  // A page that cannot be read hands the screen to the boundary's download card.
  if (failed) throw new Error('The PDF could not be shown.');
  if (!doc) return <Loading what="PDF" />;

  const go = (n: number) => setCurrent(clampPage(n, count));
  return (
    <div className="flex flex-col gap-2">
      <div role="toolbar" aria-label="PDF controls" className="flex flex-wrap items-center gap-2">
        <button type="button" className={TOOL} onClick={() => go(current - 1)} disabled={current <= 1} aria-label="Previous page">
          Previous
        </button>
        <button type="button" className={TOOL} onClick={() => go(current + 1)} disabled={current >= count} aria-label="Next page">
          Next
        </button>
        <label className="flex items-center gap-1 text-sm">
          <span className="sr-only">Page number</span>
          <input
            inputMode="numeric"
            aria-label="Page number"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTyped(String(current))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const n = parsePageInput(typed, count);
              if (n !== null) go(n);
              else setTyped(String(current));
            }}
            className="w-14 rounded-md border border-line bg-page px-2 py-1 text-center text-sm"
          />
          <span className="text-muted">of {count}</span>
        </label>
        <button type="button" className={TOOL} onClick={() => setZoom(nextZoom(zoom, -1))} disabled={zoom <= ZOOM_STEPS[0]} aria-label="Zoom out">
          −
        </button>
        <span className="min-w-12 text-center text-sm text-muted" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className={TOOL} onClick={() => setZoom(nextZoom(zoom, 1))} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} aria-label="Zoom in">
          +
        </button>
      </div>
      <p className="sr-only" role="status">{`Page ${current} of ${count}`}</p>
      <div className="max-h-[75vh] overflow-auto rounded-md border border-line bg-hover p-2">
        <canvas ref={canvas} role="img" aria-label={`Page ${current} of ${count}`} className="mx-auto block" />
      </div>
    </div>
  );
}
