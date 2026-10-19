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

describe.each([
  ['light', ':root'],
  ['dark', "[data-theme='dark']"],
])('the %s palette meets WCAG AA', (_name, selector) => {
  const t = tokens(selector);
  const AUTHORS = [0, 1, 2, 3, 4, 5, 6, 7];

  test('declares every token the console uses', () => {
    for (const name of [
      'page', 'sidebar', 'surface', 'line', 'fg', 'muted', 'hover', 'active',
      'accent', 'accent-fg', 'accent-text', 'danger', 'success',
      'dot-failed', 'dot-review', 'dot-editing',
      ...AUTHORS.map((i) => `author-${i}`),
    ]) {
      expect(t[name], `--${name}`).toBeTruthy();
    }
  });

  test('body and muted text read on the page, the sidebar and a surface (4.5:1)', () => {
    for (const bg of ['page', 'sidebar', 'surface']) {
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
