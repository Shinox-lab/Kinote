import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { parseConfig } from '../load/config.js';
import { ensureTextTarget, findTextTargets, navigationDelay, pickOtherPage } from '../load/editor.js';
import { LatencyMeter, percentile } from '../load/metrics.js';
import { mapLimit } from '../load/util.js';

/** A Y.Doc shaped like a BlockNote page: fragment > blockGroup > blockContainer > paragraph > text. */
function pageDoc(texts: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('document-store');
  const group = new Y.XmlElement('blockGroup');
  fragment.insert(0, [group]);
  texts.forEach((value, index) => {
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', `block-${index}`);
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, value);
    paragraph.insert(0, [text]);
    container.insert(0, [paragraph]);
    group.insert(index, [container]);
  });
  return doc;
}

describe('load harness config', () => {
  test('defaults to ten workspaces, two editors each, one page each', () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      workspaces: 10,
      editorsPerWorkspace: 2,
      pagesPerWorkspace: 1,
      ramp: [10],
      seedOnly: false,
    });
  });

  test('a ramp seeds the largest step and starts the steps in order', () => {
    const config = parseConfig({ RAMP: '10, 25,50' });
    expect(config.workspaces).toBe(50);
    expect(config.ramp).toEqual([10, 25, 50]);
  });

  test('fewer than two editors per workspace is refused', () => {
    expect(() => parseConfig({ EDITORS: '1' })).toThrow(/at least 2/i);
  });

  test('a ramp that goes backwards is refused', () => {
    expect(() => parseConfig({ RAMP: '50,10' })).toThrow(/increasing/i);
  });

  test('a non-positive workspace count is refused', () => {
    expect(() => parseConfig({ WORKSPACES: '0' })).toThrow(/positive/i);
  });

  test('seed only is read as a flag', () => {
    expect(parseConfig({ SEED_ONLY: '1' }).seedOnly).toBe(true);
    expect(parseConfig({ SEED_ONLY: '0' }).seedOnly).toBe(false);
  });

  test('navigation is off by default and needs two pages when enabled', () => {
    expect(parseConfig({}).navigateMs).toBe(0);
    expect(() => parseConfig({ NAVIGATE_MS: '10000' })).toThrow(/PAGES/);
    expect(parseConfig({ NAVIGATE_MS: '10000', PAGES: '2' })).toMatchObject({
      navigateMs: 10000,
      navReadMs: 5000,
    });
    expect(parseConfig({ NAVIGATE_MS: '10000', NAV_READ_MS: '1500', PAGES: '2' }).navReadMs).toBe(1500);
  });

  test('navigation jitter is off by default and spreads the next switch', () => {
    expect(parseConfig({}).navigateJitterMs).toBe(0);
    expect(
      parseConfig({ NAVIGATE_MS: '10000', NAVIGATE_JITTER_MS: '5000', PAGES: '2' }).navigateJitterMs
    ).toBe(5000);
    expect(() => parseConfig({ NAVIGATE_JITTER_MS: '-1' })).toThrow(/non-negative/i);
  });
});

describe('navigation delay', () => {
  test('keeps the base interval and spreads it by the jitter window', () => {
    expect(navigationDelay(30_000, 0, () => 0.99)).toBe(30_000);
    expect(navigationDelay(30_000, 15_000, () => 0)).toBe(30_000);
    expect(navigationDelay(30_000, 15_000, () => 0.5)).toBe(37_500);
    expect(navigationDelay(30_000, 15_000, () => 0.999999)).toBeLessThan(45_000);
  });
});

describe('load harness metrics', () => {
  test('percentile is nearest-rank and empty is zero', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });

  test('the meter reports count and percentiles', () => {
    const meter = new LatencyMeter();
    meter.add(10);
    meter.add(20);
    meter.add(30);
    expect(meter.stats()).toEqual({ count: 3, p50: 20, p95: 30, p99: 30, max: 30 });
  });
});

describe('load harness editing target', () => {
  test('finds the text node inside each block', () => {
    const doc = pageDoc(['first', 'second']);
    const texts = findTextTargets(doc);
    expect(texts).toHaveLength(2);
    expect(texts.map((text) => text.toString())).toEqual(['first', 'second']);
  });

  test('creates a paragraph when the page has no editable text', () => {
    const doc = new Y.Doc();
    const text = ensureTextTarget(doc, 0);
    text.insert(0, 'typed');
    expect(findTextTargets(doc).map((target) => target.toString())).toEqual(['typed']);
  });

  test('picks the block for this editor, wrapping around', () => {
    const doc = pageDoc(['first', 'second']);
    expect(ensureTextTarget(doc, 1).toString()).toBe('second');
    expect(ensureTextTarget(doc, 2).toString()).toBe('first');
  });

  test('picks a different page and skips files', () => {
    const nodes = [
      { id: 'a', kind: 'page' },
      { id: 'b', kind: 'page' },
      { id: 'c', kind: 'file' },
      { id: 'd', kind: 'page' },
    ];
    expect(pickOtherPage(nodes, 'a', () => 0)).toBe('b');
    expect(pickOtherPage(nodes, 'a', () => 0.99)).toBe('d');
    expect(pickOtherPage(nodes, 'b', () => 0)).toBe('a');
    expect(pickOtherPage([{ id: 'a', kind: 'page' }], 'a')).toBeNull();
    expect(pickOtherPage([{ id: 'c', kind: 'file' }], 'a')).toBeNull();
  });
});

describe('mapLimit', () => {
  test('runs every item and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(item);
      active -= 1;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
