import { describe, expect, test } from 'vitest';
import { InviteMemberResponseSchema } from '@kinote/contracts';
import { MemoryMailer, type Mail, type Mailer } from '../src/mail.js';
import { INVITATION_EMAILS_PER_HOUR } from '../src/invitationMail.js';
import { eq } from 'drizzle-orm';
import { tenants, withTenantTx } from '@kinote/db';
import { TEST_PASSWORD, bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

const invite = (app: ReturnType<typeof buildTestApp>, headers: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/invitations', payload: payload as any, headers });

/** A workspace whose owner signed up on a server without email (so sign-up signs in at once). */
async function workspace(slug: string) {
  return bootstrapTenant(buildTestApp(), { name: 'Acme Research', slug, email: `owner-${slug}@example.test` });
}

describe('invitation emails', () => {
  useTestDb();

  test('with send_email the invitee gets the accept link, and the admin still gets it too', async () => {
    const mailer = new MemoryMailer();
    const app = buildTestApp({ mailer });
    const { headers } = await workspace('acme');

    const res = await invite(app, headers, { email: 'new@example.test', role: 'member', send_email: true });
    expect(res.statusCode).toBe(201);
    const body = InviteMemberResponseSchema.parse(res.json());
    expect(body.emailed).toBe(true);

    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail!.to).toBe('new@example.test');
    expect(mail!.subject).toBe("You're invited to a Kinote workspace");
    expect(mail!.text).toContain('owner-acme invited you to join the workspace "Acme Research" on Kinote as a member.');
    expect(mail!.text).toContain(`https://wiki.example/accept-invite/${encodeURIComponent(body.acceptToken)}`);

    // The emailed link signs the invitee up into the workspace.
    const token = decodeURIComponent(mailer.lastLink('new@example.test')!.split('/').at(-1)!);
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { invitation_token: token, name: 'New', password: TEST_PASSWORD },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().user.email).toBe('new@example.test');
  });

  test('without send_email, or on a server without email, nothing is sent', async () => {
    const mailer = new MemoryMailer();
    const { headers } = await workspace('quiet');

    const plain = await invite(buildTestApp({ mailer }), headers, { email: 'a@example.test', role: 'member' });
    expect(plain.json().emailed).toBe(false);
    expect(mailer.sent).toHaveLength(0);

    const noMail = await invite(buildTestApp(), headers, { email: 'b@example.test', role: 'viewer', send_email: true });
    expect(noMail.statusCode).toBe(201);
    expect(noMail.json().emailed).toBe(false);
  });

  test('a member who may not invite sends no email', async () => {
    const mailer = new MemoryMailer();
    const app = buildTestApp({ mailer });
    const { tenant } = await workspace('members');
    const member = await signUpMember(buildTestApp(), tenant.id, 'member');

    const res = await invite(app, member.headers, { email: 'x@example.test', role: 'member', send_email: true });
    expect(res.statusCode).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  test(`a workspace sends at most ${INVITATION_EMAILS_PER_HOUR} an hour; past that the invitation is still made`, async () => {
    const mailer = new MemoryMailer();
    const app = buildTestApp({ mailer });
    const { headers } = await workspace('busy');

    for (let i = 0; i < INVITATION_EMAILS_PER_HOUR; i++) {
      const res = await invite(app, headers, { email: `p${i}@example.test`, role: 'viewer', send_email: true });
      expect(res.json().emailed).toBe(true);
    }
    const over = await invite(app, headers, { email: 'one-more@example.test', role: 'viewer', send_email: true });
    expect(over.statusCode).toBe(201);
    expect(over.json().emailed).toBe(false);
    expect(over.json().acceptToken).toBeTruthy();
    expect(mailer.sent).toHaveLength(INVITATION_EMAILS_PER_HOUR);

    // Another workspace has its own allowance.
    const other = await workspace('other');
    expect((await invite(app, other.headers, { email: 'c@example.test', role: 'viewer', send_email: true })).json().emailed).toBe(true);
  });

  test('a mail server failure is answered with emailed: false, not an error', async () => {
    const failing: Mailer = {
      publicUrl: 'https://wiki.example',
      async send(_mail: Mail) {
        throw new Error('smtp down');
      },
    };
    const { headers } = await workspace('down');
    const res = await invite(buildTestApp({ mailer: failing }), headers, { email: 'd@example.test', role: 'admin', send_email: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().emailed).toBe(false);
  });

  test('names in the email stay on one line', async () => {
    const mailer = new MemoryMailer();
    const { tenant, headers } = await workspace('two-lines');
    await withTenantTx(tenant.id, (tx) => tx.update(tenants).set({ name: 'Two\n\nLines' }).where(eq(tenants.id, tenant.id)));
    await invite(buildTestApp({ mailer }), headers, { email: 'e@example.test', role: 'member', send_email: true });
    expect(mailer.sent[0]!.text.split('\n')[0]).toContain('the workspace "Two Lines" on Kinote as a member.');
  });
});
