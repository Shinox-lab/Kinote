import './excalidrawEnv.js';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { exportToSvg } from '@excalidraw/excalidraw';
import { api } from '../../lib/api.js';
import { useResolvedTheme } from '../../lib/useResolvedTheme.js';

/**
 * A read-only picture of one side of a drawing (a version's scene, or the
 * live one when `version` is null), drawn by Excalidraw's `exportToSvg`.
 * Loaded lazily with Excalidraw, only where a diff shows a drawing.
 */
export default function DrawingPreview({ pageId, drawingId, version, label }: { pageId: string; drawingId: string; version: number | null; label: string }) {
  const theme = useResolvedTheme();
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const scene = useQuery({
    queryKey: ['drawing', pageId, drawingId, version],
    queryFn: () => api.getDrawing(pageId, drawingId, version),
    staleTime: version === null ? 0 : Infinity,
  });

  useEffect(() => {
    const elements = scene.data?.elements;
    if (!elements || !box.current) return;
    let cancelled = false;
    exportToSvg({
      elements: elements as any,
      appState: { exportBackground: false, exportWithDarkMode: theme === 'dark' } as any,
      files: null,
    })
      .then((svg: SVGSVGElement) => {
        if (cancelled || !box.current) return;
        svg.setAttribute('width', '100%');
        svg.removeAttribute('height');
        svg.style.maxHeight = '320px';
        // Built by Excalidraw with DOM calls from the scene's JSON; inserted as a node, never as markup.
        box.current.replaceChildren(svg);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [scene.data, theme]);

  if (scene.isError || failed) return <p className="text-xs text-muted">This drawing couldn't load</p>;
  if (scene.data && scene.data.elements.length === 0) return <p className="text-xs text-muted">Empty drawing</p>;
  return <div ref={box} role="img" aria-label={label} className="min-h-16 w-full overflow-hidden rounded border border-[var(--border)] p-1" />;
}
