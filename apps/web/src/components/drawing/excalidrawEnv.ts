// Excalidraw fetches its fonts from window.EXCALIDRAW_ASSET_PATH (D11): Kinote
// serves them itself, never a CDN. Imported first by every module that loads
// Excalidraw (the canvas, and the previews in review and history).
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';

/** The CDN Excalidraw appends to every font's sources, after the asset path. */
const CDN_SOURCE = /,\s*url\(https:\/\/esm\.sh\/@excalidraw\/[^)]*\)(\s*format\('[^']*'\))?/g;

/**
 * Excalidraw always lists esm.sh as each font's last source. The console's
 * Content-Security-Policy (font-src 'self') blocks it anyway, but Chrome checks
 * every listed source when the font is created and logs one violation per font
 * (over 200 for a drawing). Dropping that source keeps the console quiet and
 * the fonts strictly Kinote's own.
 */
export function withoutCdnSource(source: string | BufferSource): string | BufferSource {
  return typeof source === 'string' ? source.replace(CDN_SOURCE, '') : source;
}

const NativeFontFace = window.FontFace;
if (NativeFontFace && !(NativeFontFace as { kinoteWrapped?: boolean }).kinoteWrapped) {
  const Wrapped = function FontFace(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    return new NativeFontFace(family, withoutCdnSource(source), descriptors);
  } as unknown as typeof FontFace & { kinoteWrapped: boolean };
  Wrapped.prototype = NativeFontFace.prototype;
  Wrapped.kinoteWrapped = true;
  window.FontFace = Wrapped;
}
