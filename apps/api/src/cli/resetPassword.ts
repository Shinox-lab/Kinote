// Operator CLI: prints a one-time link that sets a new password for an account,
// and signs that account out everywhere. For someone locked out of their
// account, or a server without email. Never an admin route: a workspace admin
// must not reset the password of a person who also belongs to other workspaces.
//
//   docker compose exec api node_modules/.bin/tsx apps/api/src/cli/resetPassword.ts someone@example.com
//   pnpm reset-password someone@example.com          (outside Docker, with DATABASE_URL set)
//
// The link works once, for an hour. Opening it also counts as confirming the
// email address, so give it only to the person who owns that inbox.
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initDb, users } from '@kinote/db';
import { loadConfig } from '@kinote/shared';
import { createEmailToken } from '../auth/emailTokens.js';
import { revokeAllSessions } from '../auth/sessions.js';

export async function resetPasswordLink(email: string, publicUrl: string | undefined): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const [user] = await getDb().select().from(users).where(eq(users.email, normalized));
  if (!user || user.passwordHash === '!') throw new Error(`no account can sign in with ${normalized}`);
  const token = await createEmailToken(user.id, 'reset');
  await revokeAllSessions(user.id);
  return `${(publicUrl ?? '').replace(/\/+$/, '')}/reset-password/${token}`;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) throw new Error('usage: reset-password <email>');
  const config = loadConfig();
  initDb({ url: config.DATABASE_URL });
  try {
    const link = await resetPasswordLink(email, config.PUBLIC_URL);
    console.log(config.PUBLIC_URL ? link : `${link}\n(prefix it with the console's address, or set PUBLIC_URL)`);
    console.log('The account is signed out everywhere. The link works once, within an hour.');
  } finally {
    await closeDb();
  }
}

// Run only as a script, not when a test imports resetPasswordLink.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error('reset-password failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
