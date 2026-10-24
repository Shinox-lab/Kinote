import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ZOOM_STEPS, clampPage, fitScale, nextZoom, parsePageInput } from '../lib/pdfPages.js';
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
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [fitZoom, setFitZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [typed, setTyped] = useState('1');
  const count = doc?.numPages ?? 0;
  const effective = fit ? fitZoom : zoom;

  // Open the document (in pdf.js's own worker). The worker takes ownership of the buffer it is given, so it gets a copy.
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> | void } | null = null;
    openPdf<PDFDocumentProxy>(
      async () => {
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
        // `v=2` busts the copy nginx used to serve as application/octet-stream: the worker's own
        // name is content-hashed, so a browser would otherwise keep the unusable cached response.
        pdfjs.GlobalWorkerOptions.workerSrc = `${worker.default}?v=2`;
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

  // Fit-to-width follows the rail and the window: measure the scroller, then the page.
  useEffect(() => {
    if (!scroller.current) return;
    const element = scroller.current;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void doc.getPage(current).then((pdfPage) => {
      if (cancelled) return;
      setFitZoom(fitScale(pdfPage.getViewport({ scale: 1 }).width, width));
    });
    return () => {
      cancelled = true;
    };
  }, [doc, current, width]);

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
      const viewport = pdfPage.getViewport({ scale: effective * ratio });
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
  }, [doc, current, effective]);

  // A page that cannot be read hands the screen to the boundary's download card.
  if (failed) throw new Error('The PDF could not be shown.');
  if (!doc) return <Loading what="PDF" />;

  const go = (n: number) => setCurrent(clampPage(n, count));
  const step = (dir: 1 | -1) => {
    setFit(false);
    setZoom(nextZoom(effective, dir));
  };
  return (
    <div ref={scroller} className="relative">
      <p className="sr-only" role="status">{`Page ${current} of ${count}`}</p>
      <div className="max-h-[75vh] overflow-auto">
        <canvas ref={canvas} role="img" aria-label={`Page ${current} of ${count}`} className="mx-auto block" />
      </div>
      <div
        role="toolbar"
        aria-label="PDF controls"
        className="absolute bottom-2 left-1/2 z-10 flex w-fit -translate-x-1/2 items-center gap-1 rounded-lg border border-line bg-surface/95 p-1.5 shadow-pop backdrop-blur"
      >
        <button type="button" className={TOOL} onClick={() => go(current - 1)} disabled={current <= 1} aria-label="Previous page">
          ‹
        </button>
        <label className="flex items-center gap-1 text-xs">
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
            className="w-10 rounded border border-line bg-page px-1 py-0.5 text-center text-xs"
          />
          <span className="text-muted">/ {count}</span>
        </label>
        <button type="button" className={TOOL} onClick={() => go(current + 1)} disabled={current >= count} aria-label="Next page">
          ›
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <button type="button" className={TOOL} onClick={() => step(-1)} disabled={effective <= ZOOM_STEPS[0]} aria-label="Zoom out">
          −
        </button>
        <span className="min-w-10 text-center text-xs text-muted" aria-live="polite">
          {Math.round(effective * 100)}%
        </span>
        <button type="button" className={TOOL} onClick={() => step(1)} disabled={effective >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} aria-label="Zoom in">
          +
        </button>
        <button type="button" className={`${TOOL} ${fit ? 'bg-active' : ''}`} aria-pressed={fit} onClick={() => setFit(true)}>
          Fit
        </button>
      </div>
    </div>
  );
}
