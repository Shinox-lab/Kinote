import { describe, expect, it } from 'vitest';
import { TenantDefaultsSchema, TenantLimitsSchema } from '../src/internal.js';

// Clients (Kinote-SaaS) parse answers with these schemas; answers from a Kinote before model settings lack the
// new fields and must still parse.
describe('control-plane answers from an older Kinote', () => {
  it('defaults without askModel and creditMultiplier parse', () => {
    const old = { plan: 'free', seats: 3, storageBytes: null, creditsPerMonth: 50, indexCreditsPerMonth: null, gracePercent: 10, maxFreePerOwner: 2 };
    expect(TenantDefaultsSchema.safeParse(old).success).toBe(true);
  });

  it('limits without askModel and creditMultiplier parse', () => {
    const old = { seats: 3, storageBytes: null, creditsPerMonth: 50, indexCreditsPerMonth: null, gracePercent: 10, periodAnchorDay: 1 };
    expect(TenantLimitsSchema.safeParse(old).success).toBe(true);
  });
});
