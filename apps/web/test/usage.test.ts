import { describe, expect, test } from 'vitest';
import type { UsageSummary } from '@kinote/contracts';
import { bannerText, renewsOn, usedOf } from '../src/lib/usage.js';

const u = (over: Partial<UsageSummary>): UsageSummary => ({
  state: 'ok',
  plan: 'team',
  usedCredits: 10,
  limitCredits: 100,
  creditsTopup: 0,
  graceLeftCredits: 100,
  indexUsedCredits: 0,
  indexLimitCredits: null,
  indexHeld: false,
  storageBytes: 0,
  storageLimitBytes: null,
  seats: 1,
  seatLimit: null,
  resetsAt: '2026-12-01T00:00:00.000Z',
  billingUrl: null,
  billingState: 'ok',
  manageUrl: null,
  ...over,
});

describe('bannerText', () => {
  test('a billing problem comes before credits', () => {
    expect(bannerText(u({ billingState: 'suspended' }))).toBe('This workspace is suspended');
    expect(bannerText(u({ billingState: 'past_due' }))).toBe('Payment failed — update billing');
    expect(bannerText(u({ billingState: 'past_due', state: 'exhausted' }))).toBe('Payment failed — update billing');
  });

  test('says nothing while ok or unlimited', () => {
    expect(bannerText(u({ state: 'ok' }))).toBeNull();
    expect(bannerText(u({ state: 'unlimited', limitCredits: null }))).toBeNull();
  });

  test('warns at 80%', () => {
    expect(bannerText(u({ state: 'warn' }))).toBe("This workspace has used 80% of this month's AI credits.");
  });

  test('counts down whole credits in grace', () => {
    expect(bannerText(u({ state: 'over', graceLeftCredits: 7.9 }))).toBe(
      "Over this month's AI credits: 7 left before AI actions pause."
    );
    expect(bannerText(u({ state: 'over', graceLeftCredits: 0.4 }))).toBe(
      "Over this month's AI credits: 0 left before AI actions pause."
    );
  });

  test('past grace says when credits renew', () => {
    expect(bannerText(u({ state: 'exhausted' }))).toBe(
      "This workspace has used this month's AI credits. They renew on 1 Dec."
    );
    expect(renewsOn('2027-01-15T00:00:00.000Z')).toBe('15 Jan');
  });
});

describe('usedOf', () => {
  test('"used of limit", or just "used" with no limit', () => {
    expect(usedOf(12.5, 100)).toBe('12.5 of 100');
    expect(usedOf(1234.567, null)).toBe('1,234.567');
    expect(usedOf(3, 5, (n) => `${n} seats`)).toBe('3 seats of 5 seats');
  });
});
