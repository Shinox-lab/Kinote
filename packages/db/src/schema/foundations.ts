import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('standard'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** "Agents may answer routing questions": off, questions go to the agent's owner on the Capture page. */
  agentsMayAnswer: boolean('agents_may_answer').notNull().default(false),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  phoneE164: text('phone_e164'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the person proved the address is theirs (a link sent to it); null until then. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
});

// Global (not tenant-scoped, no RLS), like sessions: one-time links sent by
// email to verify the address or reset the password. Only the SHA-256 is stored.
export const emailTokens = pgTable(
  'email_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify', 'reset', 'setup'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)]
);

// Global (not tenant-scoped, no RLS), like users. Only the SHA-256 of the
// bearer token is stored; the token itself is shown to the client once.
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_tenant_user_idx').on(t.tenantId, t.userId)]
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member', 'viewer'] }).notNull().default('member'),
    invitedBy: uuid('invited_by').notNull(),
    /** sha256Hex of the secret half of the accept token; the secret itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one pending invitation per email; accepted ones stay as history.
    uniqueIndex('invitations_tenant_email_idx')
      .on(t.tenantId, t.email)
      .where(sql`${t.acceptedAt} is null`),
  ]
);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['curator', 'external', 'router'] }).notNull().default('external'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  /** AI actions (Ask) this agent may use a day; null means the default (100). */
  dailyAiLimit: integer('daily_ai_limit'),
  /** "Always review this agent": its routed changes wait for review even in a space without review. */
  alwaysReview: boolean('always_review').notNull().default(true),
  /** The owner may approve and reject this agent's changes in the AI client's review panel. */
  approveInClient: boolean('approve_in_client').notNull().default(true),
});

export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** At least one of read, capture, edit (agent_tokens_scopes_check). */
    scopes: text('scopes').array().notNull(),
    /** What the admin called it, e.g. "Claude Code on my laptop". */
    name: text('name').notNull().default(''),
    /** The first 8 characters of the secret, shown so tokens can be told apart. */
    tokenPrefix: text('token_prefix').notNull().default(''),
    /** The user who issued it. */
    createdBy: uuid('created_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Browser sign-in only: the SHA-256 of the current refresh token, rotated on every refresh. */
    refreshTokenHash: text('refresh_token_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    /** Browser sign-in only: the client that signed in. */
    oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('agent_tokens_tenant_hash_idx').on(t.tenantId, t.tokenHash),
    uniqueIndex('agent_tokens_tenant_refresh_idx').on(t.tenantId, t.refreshTokenHash).where(sql`refresh_token_hash IS NOT NULL`),
  ]
);

/**
 * MCP clients registered for browser sign-in (RFC 7591), public clients only (PKCE, no secret). Global like
 * `sessions`: a client registers before anyone picks a workspace. The name is the client's own claim.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One-time authorization codes (10 minutes; only the SHA-256 is kept). The agent is created at the exchange. */
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    codeHash: text('code_hash').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scopes: text('scopes').array().notNull(),
    agentName: text('agent_name').notNull(),
    spaceIds: uuid('space_ids').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** The token the exchange issued, so a replayed code can revoke it. */
    tokenId: uuid('token_id').references(() => agentTokens.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_codes_tenant_hash_idx').on(t.tenantId, t.codeHash)]
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('groups_tenant_name_idx').on(t.tenantId, t.name)]
);

export const groupMembers = pgTable(
  'group_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'agent'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
  },
  (t) => [
    uniqueIndex('group_members_unique_idx').on(
      t.tenantId,
      t.groupId,
      t.principalType,
      t.principalId
    ),
  ]
);

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    kind: text('kind', { enum: ['normal', 'inbox'] }).notNull().default('normal'),
    reviewRequired: boolean('review_required').notNull().default(false),
    quietSeconds: integer('quiet_seconds').notNull().default(120),
    humanProtectionSeconds: integer('human_protection_seconds').notNull().default(300),
    allowSelfApproval: boolean('allow_self_approval').notNull().default(false),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('spaces_tenant_name_idx').on(t.tenantId, t.name),
    uniqueIndex('spaces_tenant_slug_idx').on(t.tenantId, t.slug),
  ]
);

export const spaceGrants = pgTable(
  'space_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'agent', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    role: text('role', { enum: ['viewer', 'editor', 'reviewer', 'admin'] }).notNull(),
  },
  (t) => [
    uniqueIndex('space_grants_unique_idx').on(
      t.tenantId,
      t.spaceId,
      t.principalType,
      t.principalId
    ),
  ]
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  type: text('type').notNull(),
  actorType: text('actor_type', { enum: ['user', 'agent', 'connector', 'system'] }).notNull(),
  actorId: uuid('actor_id').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    queue: text('queue').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['queued', 'running', 'completed', 'dead_letter'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    rerunRequested: boolean('rerun_requested').notNull().default(false),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jobs_tenant_key_active_idx').on(t.tenantId, t.queue, t.idempotencyKey),
    index('jobs_poll_idx').on(t.status, t.runAt),
  ]
);
