import type { BrowserContext, Locator, Page } from '@playwright/test';

// A string, not a function: tsx wraps named functions in a helper that does not exist in the page.
const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__clip-cursor')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #__clip-cursor { position: fixed; left: 0; top: 0; width: 20px; height: 20px; pointer-events: none;
        z-index: 2147483647; transform: translate(-100px, -100px); }
      .__clip-ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        pointer-events: none; z-index: 2147483646; background: rgba(101, 80, 201, 0.35);
        animation: __clip-ripple 300ms ease-out forwards; }
      @keyframes __clip-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }\`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = '__clip-cursor';
    cursor.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 2l13 7.5-5.6 1.4L13.6 18l-2.6 1.1-3.2-7.1L3 15.6z" fill="#24211d" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    const move = (x, y) => {
      cursor.style.transform = 'translate(' + (x - 3) + 'px, ' + (y - 2) + 'px)';
      sessionStorage.setItem('__clipCursor', JSON.stringify([x, y]));
    };
    const last = sessionStorage.getItem('__clipCursor');
    if (last) move(...JSON.parse(last));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
    window.addEventListener('mousedown', (e) => {
      const ripple = document.createElement('div');
      ripple.className = '__clip-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top = e.clientY + 'px';
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 320);
    }, true);
  };
  // Before the parser has built the page, anything added is lost; wait for it.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();`;

/** A visible arrow cursor and a click ripple, because headless screenshots have no pointer. */
export async function installCursor(context: BrowserContext): Promise<void> {
  await context.addInitScript(CURSOR_SCRIPT);
}

const positions = new WeakMap<Page, { x: number; y: number }>();

/** Moves the mouse to the middle of `target` in 25 steps, then clicks it unless `click: false`. */
export async function glide(page: Page, target: Locator, o: { click?: boolean } = {}): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`glide: ${target} has no box`);
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const from = positions.get(page);
  if (!from) await page.mouse.move(to.x - 120, to.y + 80);
  await page.mouse.move(to.x, to.y, { steps: 25 });
  positions.set(page, to);
  if (o.click === false) return;
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.up();
}

/** Types at a human pace. */
export async function typeHuman(target: Locator, text: string): Promise<void> {
  await target.pressSequentially(text, { delay: 28 });
}
