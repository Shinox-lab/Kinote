import { z } from 'zod';

// The control-plane API (/internal/v1/): how Kinote-SaaS sets a workspace's
// limits, adds top-ups and reads usage. Within v1 changes are additive only.
// Reference: docs/control-plane-api.md.

export const CreditStateSchema = z.enum(['unlimited', 'ok', 'warn', 'over', 'exhausted']);

const limitNumber = z.number().int().min(0).nullable();

export const LimitsInputSchema = z
  .object({
    // 'demo' is Kinote's own marker for the demo workspace (it changes how deletion works): never a plan label.
    plan: z
      .string()
      .min(1)
      .max(40)
      .refine((v) => v.trim().toLowerCase() !== 'demo', "'demo' is reserved"),
    seats: limitNumber,
    storageBytes: limitNumber,
    creditsPerMonth: limitNumber,
    indexCreditsPerMonth: limitNumber,
    gracePercent: z.number().int().min(0).max(100).optional(),
    periodAnchorDay: z.number().int().min(1).max(28).optional(),
  })
  .strict();
export type LimitsInput = z.infer<typeof LimitsInputSchema>;

/** PUT /internal/v1/tenants/:id/limits: the new limits, or null to remove them all. */
export const PutLimitsRequestSchema = LimitsInputSchema.nullable();

export const TenantLimitsSchema = z.object({
  seats: z.number().int().nullable(),
  storageBytes: z.number().int().nullable(),
  creditsPerMonth: z.number().int().nullable(),
  indexCreditsPerMonth: z.number().int().nullable(),
  gracePercent: z.number().int(),
  periodAnchorDay: z.number().int(),
});

export const TenantUsageSchema = z.object({
  /** The period's start date, YYYY-MM-DD (UTC). */
  period: z.string(),
  /** When the period ends (exclusive), ISO. */
  periodEnd: z.string(),
  creditsUsed: z.number(),
  indexCreditsUsed: z.number(),
  creditsTopup: z.number().int(),
  storageBytes: z.number().int(),
  seats: z.number().int(),
  state: CreditStateSchema,
  indexHeld: z.boolean(),
});
export type TenantUsage = z.infer<typeof TenantUsageSchema>;

export const InternalTenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  plan: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  seats: z.number().int(),
});
export type InternalTenant = z.infer<typeof InternalTenantSchema>;

export const InternalTenantDetailSchema = InternalTenantSchema.extend({
  limits: TenantLimitsSchema.nullable(),
  usage: TenantUsageSchema,
});
export type InternalTenantDetail = z.infer<typeof InternalTenantDetailSchema>;

export const TopupInputSchema = z
  .object({ credits: z.number().int().positive(), idempotencyKey: z.string().min(1).max(200) })
  .strict();

export const InfoSchema = z.object({
  kinoteVersion: z.string(),
  apiVersion: z.literal(1),
  features: z.array(z.string()),
});

export const TenantPageSchema = z.object({
  tenants: z.array(InternalTenantSchema),
  /** Pass as `after` for the next page; null when this was the last. */
  next: z.string().uuid().nullable(),
});

export const UsagePageSchema = z.object({
  usage: z.array(TenantUsageSchema.extend({ tenantId: z.string().uuid() })),
  next: z.string().uuid().nullable(),
});

export const PageQuerySchema = z.object({
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const UsageQuerySchema = PageQuerySchema.extend({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'must be a real date')
    .optional(),
});

/** GET /api/v1/usage: where this workspace stands, for any member (the billing link for owners and admins only). */
export const UsageSummarySchema = z.object({
  state: CreditStateSchema,
  plan: z.string(),
  usedCredits: z.number(),
  limitCredits: z.number().nullable(),
  creditsTopup: z.number().int(),
  graceLeftCredits: z.number().nullable(),
  indexUsedCredits: z.number(),
  indexLimitCredits: z.number().nullable(),
  indexHeld: z.boolean(),
  storageBytes: z.number().int(),
  storageLimitBytes: z.number().int().nullable(),
  seats: z.number().int(),
  seatLimit: z.number().int().nullable(),
  /** When this period's credits renew (ISO). */
  resetsAt: z.string(),
  billingUrl: z.string().nullable(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
