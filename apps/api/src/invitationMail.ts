import { eq } from 'drizzle-orm';
import { getDb, hitLimit, tenants, users, withTenantTx } from '@kinote/db';
import type { InviteMemberResponse } from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { trySend, type Mailer } from './mail.js';

/**
 * Invitation emails one workspace can send an hour. Anyone may create a
 * workspace where sign-up is open, so this keeps the server from being an
 * open relay for invitations to arbitrary addresses.
 */
export const INVITATION_EMAILS_PER_HOUR = 20;

const ROLE_PHRASE = { admin: 'an admin', member: 'a member', viewer: 'a viewer' } as const;

/** A workspace or person's name on one line, for a plain-text email. */
function oneLine(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Emails a fresh invitation's link to the invitee. True when it went; false
 * when the workspace has used its hourly emails or the mail server failed
 * (logged), and the admin sends the link themselves.
 */
export async function emailInvitation(
  mailer: Mailer,
  actor: Actor,
  invited: Omit<InviteMemberResponse, 'emailed'>,
  log: { error: (obj: object, msg: string) => void }
): Promise<boolean> {
  const { allowed } = await hitLimit(`invite-mail:${actor.tenantId}`, INVITATION_EMAILS_PER_HOUR, 60 * 60 * 1000);
  if (!allowed) return false;

  const [tenant] = await withTenantTx(actor.tenantId, (tx) =>
    tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, actor.tenantId))
  );
  const [inviter] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, actor.principalId));
  if (!tenant) return false;

  const { email, role, expiresAt } = invited.invitation;
  const link = `${mailer.publicUrl}/accept-invite/${encodeURIComponent(invited.acceptToken)}`;
  const who = inviter ? oneLine(inviter.name) : 'Someone';
  return trySend(
    mailer,
    {
      to: email,
      // Names stay out of the subject: they're whatever the workspace typed.
      subject: "You're invited to a Kinote workspace",
      text:
        `${who} invited you to join the workspace "${oneLine(tenant.name)}" on Kinote as ${ROLE_PHRASE[role]}.\n\n` +
        `Open this link to accept. It works once, for ${email}, until ${expiresAt.slice(0, 10)} (UTC):\n\n` +
        `${link}\n\n` +
        `If you weren't expecting this, you can ignore this email.`,
    },
    log
  );
}
