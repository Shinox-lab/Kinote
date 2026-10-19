import { useRouter, useParams } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { endSession, queryClient } from '../lib/queryClient.js';
import { ME_KEY } from '../lib/queries.js';
import { loadSession, saveSession } from '../lib/session.js';
import { AuthShell, Button, ErrorNote } from '../components/ui.js';

/** The invitee, signed in as the invited email, accepts here; the token comes from the link. */
export function AcceptInvitePage() {
  const { token } = useParams({ from: '/accept-invite/$token' });
  const router = useRouter();
  const session = loadSession();

  const accept = useMutation({
    mutationFn: () => api.acceptInvitation({ token }),
    onSuccess: async ({ tenant }) => {
      if (session) saveSession({ ...session, tenantId: tenant.id, tenantSlug: tenant.slug });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      router.history.push(`/w/${encodeURIComponent(tenant.slug)}`);
    },
  });

  const switchAccount = () => {
    endSession();
    router.history.push(`/sign-in?redirect=${encodeURIComponent(`/accept-invite/${encodeURIComponent(token)}`)}`);
  };

  return (
    <AuthShell title="Accept your invitation">
      <p className="mb-4 text-sm text-slate-700">
        You are signed in as <strong>{session?.user.email}</strong>. An invitation only works for the account with
        the email it was sent to.
      </p>
      <div className="flex flex-col gap-3">
        <ErrorNote error={accept.error} />
        <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
          {accept.isPending ? 'Joining…' : 'Join the workspace'}
        </Button>
        <Button variant="secondary" onClick={switchAccount}>
          Use another account
        </Button>
      </div>
    </AuthShell>
  );
}
