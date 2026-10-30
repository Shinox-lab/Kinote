// The Excalidraw canvas of one drawing block: loaded lazily (only pages with a
// drawing download Excalidraw), bound live to the page document, with other
// people's pointers. Fonts come from Kinote itself (excalidrawEnv).
import './excalidrawEnv.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, reconcileElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { DRAWINGS_MAP, liveElementsOf, type DrawingElement } from '@kinote/contracts';
import { loadSession } from '../../lib/session.js';
import { bindDrawing, detached } from './binding.js';
import { IMAGE_REFUSED, isImagePaste, withoutImages, type LiveDoc } from './drawingRules.js';

type ExcalidrawApi = Parameters<NonNullable<Parameters<typeof Excalidraw>[0]['excalidrawAPI']>>[0];
type Collaborators = Map<string, { pointer?: { x: number; y: number; tool: 'pointer' }; button?: 'up' | 'down'; username?: string; color?: { background: string; stroke: string } }>;

/** Pointer colours for other people (canvas colours, so plain values, not CSS variables). */
const POINTER_COLOURS = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#f08c00'];
const colourOf = (key: string) => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  const stroke = POINTER_COLOURS[Math.abs(h) % POINTER_COLOURS.length]!;
  return { background: `${stroke}33`, stroke };
};

export default function DrawingCanvas({
  live,
  drawingId,
  editable,
  theme,
  onFull,
  onNotice,
}: {
  live: LiveDoc;
  drawingId: string;
  editable: boolean;
  theme: 'light' | 'dark';
  onFull: (full: boolean) => void;
  onNotice: (notice: string) => void;
}) {
  const [api, setApi] = useState<ExcalidrawApi | null>(null);
  const [collaborators, setCollaborators] = useState<Collaborators>(new Map());
  const binding = useRef<ReturnType<typeof bindDrawing> | null>(null);
  const origin = useMemo(() => ({ drawingId }), [drawingId]);
  const initialElements = useMemo(() => {
    const scene = live.ydoc.getMap<unknown>(DRAWINGS_MAP).get(drawingId) as { entries(): Iterable<[string, unknown]> } | undefined;
    return scene && typeof scene.entries === 'function' ? liveElementsOf(scene.entries()).map(detached) : [];
    // The initial scene only: the binding keeps it live from here.
  }, [live.ydoc, drawingId]);

  useEffect(() => {
    if (!api) return;
    const b = bindDrawing({
      doc: live.ydoc,
      drawingId,
      origin,
      api: {
        getSceneElementsIncludingDeleted: () => api.getSceneElementsIncludingDeleted() as unknown as readonly DrawingElement[],
        updateScene: ({ elements }) => api.updateScene({ elements: elements as any }),
      },
      reconcile: (local, remote) => reconcileElements(local as any, remote as any, api.getAppState()) as unknown as DrawingElement[],
      editable,
    });
    binding.current = b;
    return () => {
      b.destroy();
      binding.current = null;
    };
  }, [api, live.ydoc, drawingId, origin, editable]);

  // Other people's pointers on this drawing, from the page's awareness.
  useEffect(() => {
    const awareness = live.awareness;
    if (!awareness) return;
    const self = loadSession()?.user.id ?? null;
    const update = () => {
      const next: Collaborators = new Map();
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const d = state.drawing as { drawingId?: unknown; pointer?: { x?: unknown; y?: unknown }; button?: unknown } | undefined;
        if (!d || d.drawingId !== drawingId || typeof d.pointer?.x !== 'number' || typeof d.pointer?.y !== 'number') continue;
        const who = state.lwUser as { id?: unknown; name?: unknown } | undefined;
        if (typeof who?.id === 'string' && who.id === self) continue;
        next.set(String(clientId), {
          pointer: { x: d.pointer.x, y: d.pointer.y, tool: 'pointer' },
          button: d.button === 'down' ? 'down' : 'up',
          username: typeof who?.name === 'string' ? who.name : 'Someone',
          color: colourOf(typeof who?.id === 'string' ? who.id : String(clientId)),
        });
      }
      setCollaborators(next);
    };
    update();
    awareness.on('change', update);
    return () => {
      awareness.off('change', update);
      // This drawing's pointer goes away with the canvas.
      const mine = awareness.getLocalState()?.drawing as { drawingId?: unknown } | undefined;
      if (mine?.drawingId === drawingId) awareness.setLocalStateField('drawing', null);
    };
  }, [live.awareness, drawingId]);

  useEffect(() => {
    api?.updateScene({ collaborators: collaborators as any });
  }, [api, collaborators]);

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={{ elements: initialElements as any, appState: { viewBackgroundColor: 'transparent' } }}
      viewModeEnabled={!editable}
      isCollaborating
      theme={theme}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: null },
        tools: { image: false },
      }}
      onPaste={(data, event) => {
        if (isImagePaste(event?.clipboardData) || (data.files && Object.keys(data.files).length > 0)) {
          onNotice(IMAGE_REFUSED);
          return false;
        }
        return true;
      }}
      onChange={(elements) => {
        if (!editable) return;
        const { elements: kept, removed } = withoutImages(elements as unknown as readonly DrawingElement[]);
        if (removed) {
          onNotice(IMAGE_REFUSED);
          api?.updateScene({ elements: kept as any });
        }
        binding.current?.onChange(kept);
        onFull(binding.current?.full() ?? false);
      }}
      onPointerUpdate={({ pointer, button }) => {
        live.awareness?.setLocalStateField('drawing', { drawingId, pointer: { x: pointer.x, y: pointer.y }, button });
      }}
      onPointerUp={() => binding.current?.flush()}
    />
  );
}
