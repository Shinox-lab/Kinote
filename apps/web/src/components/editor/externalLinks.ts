// How a link inside a page opens. BlockNote's own handler calls
// window.open(href, target) without `noopener`, so the opened site could get a
// handle on the Kinote tab (window.opener) and send it to a look-alike sign-in
// page. Every link click in the editor goes through openEditorLink instead.

const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

/** The absolute URL a link may open (http, https or mailto), or null. Relative links resolve against the console. */
export function openableHref(href: string | null | undefined, base: string = window.location.href): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return OPENABLE.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Opens a link in a new tab with no opener and no referrer; anything but http, https or mailto is ignored. */
export function openEditorLink(href: string | null | undefined): void {
  const url = openableHref(href);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

/** The editor link a click landed on, if any (BlockNote marks them with data-inline-content-type="link"). */
export function editorLinkOf(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest<HTMLAnchorElement>('a[data-inline-content-type="link"]') : null;
}
