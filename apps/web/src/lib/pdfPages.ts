// Page and zoom arithmetic of the PDF viewer, kept apart from pdf.js so it can be tested.

export const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;

/** A 1-based page inside the document: anything missing or invalid is the first page, anything past the end the last. */
export function clampPage(page: number | undefined, pageCount: number): number {
  if (page === undefined || !Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, Math.max(pageCount, 1));
}

/** The next zoom step in a direction (+1 in, -1 out); a value between steps moves to the step beyond it. */
export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((z) => z > current + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-9) ?? ZOOM_STEPS[0]!;
}

/** What a typed page number means: a whole number, clamped to the document; null when it is not one. */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return clampPage(Number(trimmed), pageCount);
}
