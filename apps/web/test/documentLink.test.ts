import { describe, expect, test } from 'vitest';
import { documentHref, parseFileSearch } from '../src/lib/documentLink.js';

const ID = '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a55';

describe('documentHref', () => {
  test('a page goes to the page route, a file to the file route', () => {
    expect(documentHref('acme', 'page', ID)).toBe(`/w/acme/p/${ID}`);
    expect(documentHref('acme', 'file', ID)).toBe(`/w/acme/f/${ID}`);
  });

  test('a file keeps the page and version it was asked for', () => {
    expect(documentHref('acme', 'file', ID, { page: 3 })).toBe(`/w/acme/f/${ID}?page=3`);
    expect(documentHref('acme', 'file', ID, { version: 'v1' })).toBe(`/w/acme/f/${ID}?v=v1`);
    expect(documentHref('acme', 'file', ID, { page: 2, version: 'x' })).toBe(`/w/acme/f/${ID}?page=2&v=x`);
  });

  test('a page number that is not a positive integer adds nothing', () => {
    for (const page of [null, 0, -2, 1.5, Number.NaN]) {
      expect(documentHref('acme', 'file', ID, { page })).toBe(`/w/acme/f/${ID}`);
    }
  });

  test('a page never carries file search keys', () => {
    expect(documentHref('acme', 'page', ID, { page: 3 })).toBe(`/w/acme/p/${ID}`);
  });

  test('the slug and the id are URL-encoded', () => {
    expect(documentHref('a b', 'file', 'x/y')).toBe('/w/a%20b/f/x%2Fy');
  });
});

describe('parseFileSearch', () => {
  test('keeps a positive integer page and a version string', () => {
    expect(parseFileSearch({ page: '4', v: 'x' })).toEqual({ page: 4, v: 'x' });
    expect(parseFileSearch({ page: 4 })).toEqual({ page: 4 });
  });

  test('drops anything else', () => {
    expect(parseFileSearch({ page: 'abc' })).toEqual({});
    expect(parseFileSearch({ page: '0' })).toEqual({});
    expect(parseFileSearch({ page: '2.5' })).toEqual({});
    expect(parseFileSearch({ v: 5, other: 'x' })).toEqual({});
  });
});
