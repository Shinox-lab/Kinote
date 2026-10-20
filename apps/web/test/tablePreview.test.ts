import { describe, expect, test } from 'vitest';
import { capSheet, columnLabel, initialSheet, parseCsvRows } from '../src/lib/tablePreview.js';

describe('parseCsvRows', () => {
  test('plain rows, CRLF, a BOM and a trailing empty line', () => {
    expect(parseCsvRows('﻿a,b\r\n1,2\r\n')).toEqual({ rows: [['a', 'b'], ['1', '2']], totalRows: 2, truncated: false });
  });

  test('quotes, doubled quotes and line breaks inside a cell', () => {
    const out = parseCsvRows('name,note\n"Smith, J","said ""hi""\nthen left"\n');
    expect(out.rows).toEqual([['name', 'note'], ['Smith, J', 'said "hi"\nthen left']]);
  });

  test('a row shorter than the header keeps its own length', () => {
    expect(parseCsvRows('a,b,c\n1,2\n').rows).toEqual([['a', 'b', 'c'], ['1', '2']]);
  });

  test('keeps the first 1,000 rows and counts all of them', () => {
    const csv = Array.from({ length: 1500 }, (_, i) => `r${i},x`).join('\n');
    const out = parseCsvRows(csv);
    expect(out.rows).toHaveLength(1000);
    expect(out.totalRows).toBe(1500);
    expect(out.truncated).toBe(true);
    expect(out.rows[999]).toEqual(['r999', 'x']);
  });

  test('a cell of markup comes back as the same characters', () => {
    expect(parseCsvRows('<img src=x onerror=alert(1)>,=HYPERLINK("http://evil")\n').rows).toEqual([
      ['<img src=x onerror=alert(1)>', '=HYPERLINK("http://evil")'],
    ]);
  });

  test('empty text has no rows; an unterminated quote ends with the text', () => {
    expect(parseCsvRows('')).toEqual({ rows: [], totalRows: 0, truncated: false });
    expect(parseCsvRows('a,"b\nc').rows).toEqual([['a', 'b\nc']]);
  });
});

describe('capSheet', () => {
  test('a big sheet is cut to 200 rows by 26 columns and says so', () => {
    const rows = Array.from({ length: 300 }, (_, r) => Array.from({ length: 40 }, (_, c) => `${r}:${c}`));
    const out = capSheet(rows);
    expect(out.rows).toHaveLength(200);
    expect(out.rows[0]).toHaveLength(26);
    expect(out.rowCount).toBe(300);
    expect(out.colCount).toBe(40);
    expect(out.truncated).toBe(true);
  });

  test('a small sheet is whole', () => {
    expect(capSheet([['a', 1], ['b', 2]])).toEqual({ rows: [['a', '1'], ['b', '2']], rowCount: 2, colCount: 2, truncated: false });
  });

  test('every value is shown as plain text and nothing is evaluated', () => {
    const when = new Date('2026-10-20T00:00:00.000Z');
    const out = capSheet([[null, undefined, 3.5, true, when, '=HYPERLINK("http://evil","x")', '<b>x</b>']]);
    expect(out.rows[0]).toEqual(['', '', '3.5', 'TRUE', '2026-10-20', '=HYPERLINK("http://evil","x")', '<b>x</b>']);
  });
});

describe('columnLabel', () => {
  test('A to Z, then AA', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(701)).toBe('ZZ');
    expect(columnLabel(702)).toBe('AAA');
  });
});

describe('initialSheet', () => {
  test('the page number is the sheet number: 1-based, clamped, default the first', () => {
    expect(initialSheet(3, 2)).toBe(1);
    expect(initialSheet(3, 99)).toBe(2);
    expect(initialSheet(3, undefined)).toBe(0);
    expect(initialSheet(3, 0)).toBe(0);
    expect(initialSheet(0, 5)).toBe(0);
  });
});
