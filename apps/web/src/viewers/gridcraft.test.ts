import { describe, expect, test } from 'vitest';
import { gridcraftUrl, isSpreadsheetSave, parseGridCraftMessage } from './gridcraft.js';

describe('parseGridCraftMessage', () => {
  test('accepts ready and ignores extra fields', () => {
    expect(parseGridCraftMessage({ type: 'ready', extra: true })).toEqual({ type: 'ready' });
  });

  test('accepts a boolean dirty flag and rejects anything else', () => {
    expect(parseGridCraftMessage({ type: 'dirty', dirty: true })).toEqual({ type: 'dirty', dirty: true });
    expect(parseGridCraftMessage({ type: 'dirty', dirty: false })).toEqual({ type: 'dirty', dirty: false });
    for (const dirty of [undefined, 'true', 1, null]) {
      expect(parseGridCraftMessage({ type: 'dirty', dirty }), `dirty ${String(dirty)}`).toBeNull();
    }
    expect(parseGridCraftMessage({ type: 'dirty' })).toBeNull();
  });

  test('accepts an ArrayBuffer save unchanged', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    expect(parseGridCraftMessage({ type: 'save', name: 'Budget.xlsx', bytes })).toEqual({
      type: 'save',
      name: 'Budget.xlsx',
      bytes,
    });
  });

  test('copies a Uint8Array offset view into a fresh exact-size ArrayBuffer', () => {
    const source = new Uint8Array([9, 1, 2, 3, 9]);
    const parsed = parseGridCraftMessage({ type: 'save', name: 'Budget.xlsx', bytes: source.subarray(1, 4) });
    expect(parsed?.type).toBe('save');
    if (parsed?.type !== 'save') throw new Error('expected a save message');

    source[1] = 99;
    expect(parsed.bytes).not.toBe(source.buffer);
    expect(parsed.bytes.byteLength).toBe(3);
    expect([...new Uint8Array(parsed.bytes)]).toEqual([1, 2, 3]);
  });

  test('accepts a DataView and copies only its byte range', () => {
    const source = new Uint8Array([9, 4, 5, 6, 9]);
    const parsed = parseGridCraftMessage({
      type: 'save',
      name: 'Budget.xlsx',
      bytes: new DataView(source.buffer, 1, 3),
    });
    expect(parsed?.type).toBe('save');
    if (parsed?.type !== 'save') throw new Error('expected a save message');
    expect([...new Uint8Array(parsed.bytes)]).toEqual([4, 5, 6]);
  });

  test('rejects malformed saves', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    for (const data of [
      { type: 'save', name: '', bytes: bytes.buffer },
      { type: 'save', name: '   ', bytes: bytes.buffer },
      { type: 'save', bytes: bytes.buffer },
      { type: 'save', name: 'Budget.xlsx' },
      { type: 'save', name: 'Budget.xlsx', bytes: 'not bytes' },
      { type: 'save', name: 'Budget.xlsx', bytes: [1, 2, 3] },
    ]) {
      expect(parseGridCraftMessage(data)).toBeNull();
    }
  });

  test('accepts a failed message and rejects a non-string error', () => {
    expect(parseGridCraftMessage({ type: 'failed', error: 'Could not read the workbook' })).toEqual({
      type: 'failed',
      error: 'Could not read the workbook',
    });
    expect(parseGridCraftMessage({ type: 'failed', error: '' })).toEqual({ type: 'failed', error: '' });
    expect(parseGridCraftMessage({ type: 'failed', error: 42 })).toBeNull();
    expect(parseGridCraftMessage({ type: 'failed' })).toBeNull();
  });

  test('rejects unknown types, null, arrays, primitives and missing fields', () => {
    for (const data of [null, undefined, 'ready', 42, [], { type: 'other' }, {}, { type: 1 }]) {
      expect(parseGridCraftMessage(data)).toBeNull();
    }
  });
});

describe('isSpreadsheetSave', () => {
  test('trims and compares names case-insensitively', () => {
    expect(isSpreadsheetSave(' Budget.XLSX ', 'budget.xlsx')).toBe(true);
    expect(isSpreadsheetSave('budget.xlsx', 'BUDGET.XLSX')).toBe(true);
  });

  test('requires the same .xlsx name on both sides', () => {
    expect(isSpreadsheetSave('Budget.pdf', 'Budget.pdf')).toBe(false);
    expect(isSpreadsheetSave('Other.xlsx', 'Budget.xlsx')).toBe(false);
    expect(isSpreadsheetSave('Budget.xlsx', 'Budget.pdf')).toBe(false);
    expect(isSpreadsheetSave('', 'Budget.xlsx')).toBe(false);
    expect(isSpreadsheetSave('   ', 'Budget.xlsx')).toBe(false);
    expect(isSpreadsheetSave('.xlsx', '.xlsx')).toBe(true);
  });
});

describe('gridcraftUrl', () => {
  test('uses the official host query and encodes the author', () => {
    expect(gridcraftUrl('Ada Lovelace')).toBe('/gridcraft/?host=parent&webgl&chrome=none&author=Ada%20Lovelace');
  });

  test('omits the author when none is known', () => {
    expect(gridcraftUrl()).toBe('/gridcraft/?host=parent&webgl&chrome=none');
  });
});
