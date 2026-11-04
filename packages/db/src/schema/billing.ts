import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './foundations.js';

// Billing state, set by the control plane (PUT /internal/v1/tenants/:id/billing-state). No row = 'ok'. RLS.
export const BILLING_STATES = ['ok', 'past_due', 'suspended'] as const;
export type BillingState = (typeof BILLING_STATES)[number];

export const tenantBilling = pgTable('tenant_billing', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  state: text('state', { enum: BILLING_STATES }).notNull().default('ok'),
  manageUrl: text('manage_url'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
