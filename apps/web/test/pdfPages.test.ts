import { describe, expect, test } from 'vitest';
import { clampPage, fitScale, nextZoom, parsePageInput, ZOOM_STEPS } from '../src/lib/pdfPages.js';

describe('clampPage', () => {
  test('a missing, zero, negative or fractional page opens the first page', () => {
    for (const page of [undefined, 0, -3, 2.5, Number.NaN]) expect(clampPage(page, 10)).toBe(1);
  });

  test('a page in range is kept, one past the end is the last page', () => {
    expect(clampPage(4, 10)).toBe(4);
    expect(clampPage(10, 10)).toBe(10);
    expect(clampPage(99, 10)).toBe(10);
  });

  test('a document without pages has page 1', () => {
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('nextZoom', () => {
  test('steps along the fixed scale and stops at both ends', () => {
    expect(ZOOM_STEPS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(0.75, -1)).toBe(0.5);
  });

  test('a value between steps moves to the next step in that direction', () => {
    expect(nextZoom(1.1, 1)).toBe(1.25);
    expect(nextZoom(1.1, -1)).toBe(1);
  });
});

describe('parsePageInput', () => {
  test('a typed page number is clamped to the document; text that is not a number is no change', () => {
    expect(parsePageInput('3', 10)).toBe(3);
    expect(parsePageInput(' 12 ', 10)).toBe(10);
    expect(parsePageInput('0', 10)).toBe(1);
    expect(parsePageInput('-4', 10)).toBe(1);
    expect(parsePageInput('abc', 10)).toBeNull();
    expect(parsePageInput('', 10)).toBeNull();
    expect(parsePageInput('2.5', 10)).toBeNull();
  });
});

describe('fitScale', () => {
  test('fits the page width, clamped to 50–200%', () => {
    expect(fitScale(612, 900)).toBeCloseTo(1.43, 2);
    expect(fitScale(612, 300)).toBe(0.5);
    expect(fitScale(100, 5000)).toBe(2);
    expect(fitScale(0, 900)).toBe(1);
    expect(fitScale(612, 0)).toBe(1);
  });
});
