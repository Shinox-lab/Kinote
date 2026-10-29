/**
 * Drawings (spec D1–D13): a `drawing` block names a scene that lives beside
 * the blocks in the page document's `drawings` map (drawingId → elementId →
 * Excalidraw element JSON). Pure helpers shared by the server and the web.
 */

/** A drawing block. `text` is never written by the web: the snapshot fills it in memory with `drawingText`. */
export const drawingConfig = {
  type: 'drawing',
  propSchema: {
    drawingId: { default: '' },
    title: { default: '' },
    height: { default: 480 },
    text: { default: '' },
  },
  content: 'none',
} as const;

/** The page document's map of drawing scenes. */
export const DRAWINGS_MAP = 'drawings';
export const MAX_DRAWING_ELEMENTS = 5000;
export const MAX_DRAWING_BYTES = 1_000_000;
export const MAX_DRAWING_TEXT_LINES = 200;
export const DRAWING_HEIGHT = { min: 240, max: 1200, default: 480 } as const;
export const UNTITLED_DRAWING = 'Untitled drawing';

/** An Excalidraw element as stored: the fields Kinote reads, the rest kept as they are. */
export interface DrawingElement {
  id: string;
  /** Fractional index: the order on the canvas (string compare). */
  index: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  type: string;
  text?: string;
  [k: string]: unknown;
}

export function isDrawingElement(v: unknown): v is DrawingElement {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.index === 'string' &&
    typeof e.type === 'string' &&
    typeof e.version === 'number' &&
    Number.isFinite(e.version) &&
    typeof e.versionNonce === 'number' &&
    Number.isFinite(e.versionNonce)
  );
}

/** Excalidraw's reconcile rule: the higher `version` wins; on a tie, the lower `versionNonce`. */
export function newerElement(a: DrawingElement, b: DrawingElement): DrawingElement {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return a.versionNonce <= b.versionNonce ? a : b;
}

const byIndex = (a: DrawingElement, b: DrawingElement) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The live elements of a scene's entries (`[elementId, value]`): valid ones
 * stored under their own id, not deleted, in canvas order, at most
 * MAX_DRAWING_ELEMENTS (what every server reader reads).
 */
export function liveElementsOf(entries: Iterable<[string, unknown]>): DrawingElement[] {
  const out: DrawingElement[] = [];
  for (const [key, value] of entries) {
    if (isDrawingElement(value) && value.id === key && !value.isDeleted) out.push(value);
  }
  return out.sort(byIndex).slice(0, MAX_DRAWING_ELEMENTS);
}

/**
 * A drawing's indexed text: `Drawing: {title}` then the words of its text
 * elements (free text and labels), whitespace collapsed, in canvas order, at
 * most MAX_DRAWING_TEXT_LINES.
 */
export function drawingText(title: string, elements: DrawingElement[]): string {
  const words = elements
    .map((e) => (typeof e.text === 'string' ? e.text.replace(/\s+/g, ' ').trim() : ''))
    .filter((t) => t !== '')
    .slice(0, MAX_DRAWING_TEXT_LINES);
  return [`Drawing: ${title.trim() || UNTITLED_DRAWING}`, ...words].join('\n');
}

/** Shapes added, changed (another `version`) and removed between two scenes, by element id. */
export function drawingDiff(before: DrawingElement[], after: DrawingElement[]): { added: number; changed: number; removed: number } {
  const old = new Map(before.map((e) => [e.id, e]));
  const now = new Map(after.map((e) => [e.id, e]));
  let added = 0;
  let changed = 0;
  for (const [id, e] of now) {
    const was = old.get(id);
    if (!was) added += 1;
    else if (was.version !== e.version) changed += 1;
  }
  let removed = 0;
  for (const id of old.keys()) if (!now.has(id)) removed += 1;
  return { added, changed, removed };
}
