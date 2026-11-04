import { describe, expect, it } from 'vitest';
import { periodOf, type TenantLimits, type UsageStanding } from '@kinote/db';
import { creditVerdict, indexHeld } from '../src/index.js';

const now = new Date('2026-11-03T10:00:00Z');
const limits = (over: Partial<TenantLimits> = {}): TenantLimits => ({
  seats: null,
  storageBytes: null,
  creditsPerMonth: 100,
  indexCreditsPerMonth: 10,
  gracePercent: 10,
  periodAnchorDay: 1,
  ...over,
});
const standing = (usedCredits: number, over: Partial<UsageStanding> = {}): UsageStanding => ({
  limits: limits(),
  period: periodOf(1, now),
  creditsUsedMilli: Math.round(usedCredits * 1000),
  indexCreditsUsedMilli: 0,
  creditsTopup: 0,
  storageBytes: 0,
  warned80At: null,
  warned100At: null,
  suspended: false,
  ...over,
});

describe('creditVerdict', () => {
  it('walks ok → warn → over → exhausted at 80%, 100% and the grace limit', () => {
    expect(creditVerdict(standing(79)).state).toBe('ok');
    expect(creditVerdict(standing(80)).state).toBe('warn');
    expect(creditVerdict(standing(100)).state).toBe('over');
    const edge = creditVerdict(standing(109.999));
    expect(edge.state).toBe('over');
    expect(edge.graceLeftCredits).toBeCloseTo(0.001, 6);
    expect(creditVerdict(standing(110)).state).toBe('exhausted');
  });

  it('reports credits, the limit and when they renew', () => {
    const v = creditVerdict(standing(42.5));
    expect(v).toMatchObject({ usedCredits: 42.5, limitCredits: 100, graceLeftCredits: 67.5 });
    expect(v.resetsAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('a top-up raises the limit', () => {
    const v = creditVerdict(standing(110, { creditsTopup: 30 }));
    expect(v.state).toBe('warn');
    expect(v.limitCredits).toBe(130);
    expect(creditVerdict(standing(110, { creditsTopup: 50 })).state).toBe('ok');
  });

  it('no limits, or no credit limit, is unlimited', () => {
    expect(creditVerdict(standing(1e6, { limits: null }))).toMatchObject({ state: 'unlimited', limitCredits: null, graceLeftCredits: null });
    expect(creditVerdict(standing(1e6, { limits: limits({ creditsPerMonth: null }) })).state).toBe('unlimited');
  });

  it('a limit of 0 is exhausted from the start', () => {
    expect(creditVerdict(standing(0, { limits: limits({ creditsPerMonth: 0 }) })).state).toBe('exhausted');
  });
});

describe('indexHeld', () => {
  it('holds at the index limit plus grace; top-ups do not count', () => {
    expect(indexHeld(standing(0, { indexCreditsUsedMilli: 10_999 }))).toBe(false);
    expect(indexHeld(standing(0, { indexCreditsUsedMilli: 11_000 }))).toBe(true);
    expect(indexHeld(standing(0, { indexCreditsUsedMilli: 11_000, creditsTopup: 1000 }))).toBe(true);
    expect(indexHeld(standing(0, { limits: null, indexCreditsUsedMilli: 1e9 }))).toBe(false);
    expect(indexHeld(standing(0, { limits: limits({ indexCreditsPerMonth: null }), indexCreditsUsedMilli: 1e9 }))).toBe(false);
  });
});

describe('indexHeld when suspended', () => {
  it('holds indexing for a suspended workspace, even without index limits', () => {
    expect(indexHeld(standing(0, { limits: null, suspended: true }))).toBe(true);
    expect(indexHeld(standing(0, { limits: null }))).toBe(false);
  });
});
