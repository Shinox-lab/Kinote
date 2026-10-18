import { useEffect, useState } from 'react';
import { loadSession, signOut, type Session } from './lib/api';
import { Bootstrap } from './screens/Bootstrap';
import { Home } from './screens/Home';
import { PageEditor } from './screens/PageEditor';

// Cheap hash router: "#/page/{uuid}" — no dependency needed.
function usePageId(): string | null {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const m = hash.match(/^#\/page\/([0-9a-f-]+)$/i);
  return m ? m[1] : null;
}

export function App() {
  const session: Session | null = loadSession();
  const pageId = usePageId();

  if (!session) return <Bootstrap />;
  if (pageId) return <PageEditor session={session} pageId={pageId} />;
  return <Home session={session} onSignOut={() => signOut()} />;
}
