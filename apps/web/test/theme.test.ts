import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  THEME_KEY,
  applyTheme,
  contrastRatio,
  loadTheme,
  resolveTheme,
  saveTheme,
} from '../src/lib/theme.js';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

/** The `--name: #hex` declarations of the first block whose selector is `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

describe('loadTheme / saveTheme', () => {
  test('returns each stored choice', () => {
    for (const choice of ['light', 'dark', 'system'] as const) {
      expect(loadTheme({ getItem: (k) => (k === THEME_KEY ? choice : null) })).toBe(choice);
    }
  });

  test('is system for a missing or unknown value and when storage throws', () => {
    expect(loadTheme({ getItem: () => null })).toBe('system');
    expect(loadTheme({ getItem: () => 'sepia' })).toBe('system');
    expect(
      loadTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      })
    ).toBe('system');
  });

  test('saveTheme writes the choice under the key and swallows a throwing storage', () => {
    const written: Record<string, string> = {};
    saveTheme('dark', { setItem: (k, v) => void (written[k] = v) });
    expect(written).toEqual({ [THEME_KEY]: 'dark' });
    expect(() =>
      saveTheme('light', {
        setItem: () => {
          throw new Error('quota');
        },
      })
    ).not.toThrow();
  });
});

describe('resolveTheme / applyTheme', () => {
  test('system follows the OS setting; an explicit choice wins over it', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  test('applyTheme sets the resolved theme on the root element', () => {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    applyTheme('dark', root as unknown as HTMLElement, false);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('system', root as unknown as HTMLElement, false);
    expect(root.dataset.theme).toBe('light');
  });
});

describe('contrastRatio', () => {
  test('black on white is 21 and a colour on itself is 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
});

/** The first block's `--name: rgba(r, g, b, a)` declarations. */
function rgbaTokens(selector: string): Record<string, [number, number, number, number]> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, [number, number, number, number]> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s*;/g)) {
    out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  }
  return out;
}

/** A translucent tint laid over an opaque background, as `#rrggbb`. */
function over([r, g, b, a]: [number, number, number, number], bg: string): string {
  const base = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const mixed = [r, g, b].map((c, i) => Math.round(c * a + base[i]! * (1 - a)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

describe.each([
  ['light', ':root'],
  ['dark', "[data-theme='dark']"],
])('the %s palette meets WCAG AA', (_name, selector) => {
  const t = tokens(selector);
  const AUTHORS = [0, 1, 2, 3, 4, 5, 6, 7];

  test('declares every token the console uses', () => {
    for (const name of [
      'page', 'sidebar', 'surface', 'file-mat', 'line', 'fg', 'muted', 'faint', 'hover', 'active',
      'accent', 'accent-fg', 'accent-text', 'accent-soft', 'danger', 'success',
      'ok-bg', 'ok-line', 'ok-text', 'ok-dot',
      'warn-bg', 'warn-line', 'warn-text', 'warn-dot',
      'review-bg', 'review-line', 'review-text', 'review-dot',
      'bad-bg', 'bad-line', 'bad-text', 'bad-dot',
      'diff-changed-bg', 'diff-changed-line',
      'diff-added-bg', 'diff-added-line',
      'diff-removed-bg', 'diff-removed-line',
      'dot-failed', 'dot-review', 'dot-editing',
      ...AUTHORS.map((i) => `author-${i}`),
    ]) {
      expect(t[name], `--${name}`).toBeTruthy();
    }
  });

  const BASES = {
    light: {
      page: '#fcfbf9', sidebar: '#f5f2ed', surface: '#ffffff', 'file-mat': '#f1ede7', line: '#e8e2d9',
      fg: '#24211d', muted: '#6b645b', faint: '#8d857b',
      accent: '#6550c9', 'accent-fg': '#ffffff', 'accent-text': '#5b43c7', 'accent-soft': '#ece6fa',
      success: '#2b7355', danger: '#9c3a30',
    },
    dark: {
      page: '#1a1713', sidebar: '#141210', surface: '#221e19', 'file-mat': '#211d18', line: '#302a23',
      fg: '#ece6dd', muted: '#a79c8e', faint: '#7c7266',
      accent: '#a08cff', 'accent-fg': '#1a1713', 'accent-text': '#c8b9ff', 'accent-soft': '#2c2542',
      success: '#6cc39b', danger: '#e58a80',
    },
  } as const;

  test('the design base values are the palette', () => {
    for (const [name, value] of Object.entries(BASES[_name as 'light' | 'dark'])) {
      expect(t[name], `--${name}`).toBe(value);
    }
  });

  test('status chip text reads on its fill (4.5:1)', () => {
    for (const [text, bg] of [['ok-text', 'ok-bg'], ['warn-text', 'warn-bg'], ['review-text', 'review-bg'], ['bad-text', 'bad-bg']] as const) {
      expect(contrastRatio(t[text]!, t[bg]!), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('body and muted text read on the page, the sidebar and a surface (4.5:1)', () => {
    for (const bg of ['page', 'sidebar', 'surface', 'file-mat']) {
      expect(contrastRatio(t.fg!, t[bg]!), `fg on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.muted!, t[bg]!), `muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['accent-text']!, t[bg]!), `accent-text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.danger!, t[bg]!), `danger on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.success!, t[bg]!), `success on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('text on the accent button reads (4.5:1)', () => {
    expect(contrastRatio(t['accent-fg']!, t.accent!)).toBeGreaterThanOrEqual(4.5);
  });

  test('the status dots and author colours stand out on the page and the sidebar (3:1)', () => {
    for (const bg of ['page', 'sidebar']) {
      for (const dot of ['dot-failed', 'dot-review', 'dot-editing', ...AUTHORS.map((i) => `author-${i}`)]) {
        expect(contrastRatio(t[dot]!, t[bg]!), `${dot} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('text on the author tints (changes list, highlighted blocks) reads too (4.5:1)', () => {
    const tints = rgbaTokens(selector);
    for (const i of AUTHORS) {
      for (const bg of ['page', 'sidebar', 'surface']) {
        const tint = over(tints[`author-${i}-tint`]!, t[bg]!);
        expect(contrastRatio(t.fg!, tint), `fg on author-${i} over ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.muted!, tint), `muted on author-${i} over ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('muted text reads on the hover and active row backgrounds (4.5:1)', () => {
    for (const bg of ['hover', 'active']) expect(contrastRatio(t.muted!, t[bg]!), `muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test('the sidebar row states are distinguishable from the sidebar', () => {
    expect(t.hover).not.toBe(t.sidebar);
    expect(t.active).not.toBe(t.hover);
    expect(contrastRatio(t.fg!, t.active!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the pre-paint script in index.html', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  test('runs before the page renders and reads the same storage key as theme.ts', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(`localStorage.getItem('${THEME_KEY}')`);
    expect(head).toContain('document.documentElement.dataset.theme');
  });

  test('is wrapped so blocked storage cannot break the page', () => {
    expect(html).toMatch(/try\s*{[^}]*localStorage[^}]*}\s*catch/);
  });
});
