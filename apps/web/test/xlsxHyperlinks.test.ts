import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// The spreadsheet viewer opens a cell's hyperlink itself, with no hook for the
// app. patches/@extend-ai__react-xlsx@0.18.1.patch limits it to http, https and
// mailto. An upgrade drops the patch (pnpm refuses it for another version), so
// this fails until the new version is checked and patched again.
describe('spreadsheet hyperlinks', () => {
  test('the installed viewer opens only http, https and mailto links', () => {
    const require = createRequire(import.meta.url);
    const entry = path.join(path.dirname(require.resolve('@extend-ai/react-xlsx')), 'index.js');
    const code = readFileSync(entry, 'utf8');
    expect(code).toContain('Kinote patch: a workbook');
    expect(code).toMatch(/url\.protocol === "http:" \|\| url\.protocol === "https:" \|\| url\.protocol === "mailto:"/);
    expect(code).not.toContain('window.open(externalTarget');
  });
});
