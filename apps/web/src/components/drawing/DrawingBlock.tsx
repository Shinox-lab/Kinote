import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { DRAWINGS_MAP, UNTITLED_DRAWING, drawingText, liveElementsOf } from '@kinote/contracts';
import { useResolvedTheme } from '../../lib/useResolvedTheme.js';
import { Button } from '../ui.js';
import { DRAWING_FAILED, DRAWING_FULL, SHAPES_ELSEWHERE, clampHeight, sceneMissing, useLiveDoc, type LiveDoc } from './drawingRules.js';

const DrawingCanvas = lazy(() => import('./DrawingCanvas.js'));

/** The drawing's words (D7), shown when the canvas can't load so its content stays readable. */
function wordsOf(live: LiveDoc | null, drawingId: string, title: string): string {
  const scene = live?.ydoc.getMap<unknown>(DRAWINGS_MAP).get(drawingId) as { entries?: () => Iterable<[string, unknown]> } | undefined;
  return drawingText(title, typeof scene?.entries === 'function' ? liveElementsOf(scene.entries()) : []);
}

/** Catches a failed chunk load or a canvas crash: "This drawing couldn't load", Retry, and the drawing's words. */
class CanvasBoundary extends Component<{ fallback: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('[drawing] canvas failed', error);
  }
  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/**
 * A drawing block (D1): its title, the Excalidraw canvas at its height (a
 * sized placeholder while Excalidraw loads), a full-screen button and, for
 * editors, a drag handle on the bottom edge. Outside the live editor (no
 * live document) it shows the drawing's title only.
 */
export function DrawingBlock({
  drawingId,
  title,
  height,
  editable,
  update,
}: {
  drawingId: string;
  title: string;
  height: number;
  editable: boolean;
  update: (props: { title?: string; height?: number }) => void;
}) {
  const live = useLiveDoc();
  const theme = useResolvedTheme();
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draftHeight, setDraftHeight] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState(title);
  useEffect(() => setDraftTitle(title), [title]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  // A block pasted from another page has no scene here: say so instead of looking silently empty.
  const [missing, setMissing] = useState(() => (live ? sceneMissing(live.ydoc, drawingId) : false));
  useEffect(() => {
    if (!live) return;
    const root = live.ydoc.getMap<unknown>(DRAWINGS_MAP);
    const update = () => setMissing(sceneMissing(live.ydoc, drawingId));
    update();
    root.observe(update);
    return () => root.unobserve(update);
  }, [live, drawingId]);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const shown = draftHeight ?? clampHeight(height);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: shown };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (drag.current) setDraftHeight(clampHeight(drag.current.startHeight + e.clientY - drag.current.startY));
  };
  const onResizeEnd = () => {
    if (drag.current && draftHeight !== null) update({ height: draftHeight });
    drag.current = null;
    setDraftHeight(null);
  };

  const canvas = live ? (
    <CanvasBoundary
      fallback={(retry) => (
        <div className="flex h-full flex-col gap-2 p-4 text-sm" role="alert">
          <p className="font-medium text-fg">{DRAWING_FAILED}</p>
          <Button variant="secondary" className="self-start" onClick={retry}>
            Retry
          </Button>
          <pre className="whitespace-pre-wrap text-xs text-muted">{wordsOf(live, drawingId, title)}</pre>
        </div>
      )}
    >
      <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">Loading drawing…</div>}>
        <DrawingCanvas live={live} drawingId={drawingId} editable={editable} theme={theme} onFull={setFull} onNotice={setNotice} />
      </Suspense>
    </CanvasBoundary>
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-muted">{title.trim() || UNTITLED_DRAWING}</div>
  );

  return (
    <div className="drawing-block flex w-full flex-col gap-1" contentEditable={false} data-drawing-id={drawingId}>
      <div className="flex items-center gap-2">
        {editable ? (
          <input
            aria-label="Drawing title"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-fg outline-none placeholder:text-muted"
            placeholder={UNTITLED_DRAWING}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => draftTitle !== title && update({ title: draftTitle.slice(0, 200) })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="flex-1 text-sm font-medium text-fg">{title.trim() || UNTITLED_DRAWING}</span>
        )}
        {full && <span className="text-xs font-medium text-warn-text">{DRAWING_FULL}</span>}
        <button type="button" className="text-xs font-medium text-accent-text hover:underline max-md:min-h-11" onClick={() => setExpanded(true)}>
          Full screen
        </button>
      </div>
      {missing && <p className="text-xs text-muted">{SHAPES_ELSEWHERE}</p>}
      {notice && (
        <p role="status" className="text-xs text-warn-text">
          {notice}
        </p>
      )}
      <div
        className={
          expanded
            ? 'fixed inset-0 z-50 flex flex-col bg-[var(--bg)]'
            : 'relative w-full overflow-hidden rounded-md border border-[var(--border)]'
        }
        style={expanded ? undefined : { height: shown }}
      >
        {expanded && (
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
            <span className="font-medium text-fg">{title.trim() || UNTITLED_DRAWING}</span>
            <Button variant="secondary" onClick={() => setExpanded(false)}>
              Close
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1" style={expanded ? undefined : { height: '100%' }}>
          {canvas}
        </div>
        {editable && !expanded && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize drawing"
            className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize hover:bg-[var(--routing-tint)]"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
          />
        )}
      </div>
    </div>
  );
}
