import { useEffect, useState } from 'react';

/**
 * Runs `work` once per `key` and returns its result (undefined while it runs). A failure is rethrown
 * during render, so the nearest ViewerBoundary shows its fallback instead of a half-built viewer.
 */
export function useAsyncOrThrow<T>(key: string, work: () => Promise<T>): T | undefined {
  const [state, setState] = useState<{ key: string; value?: T; failed?: boolean }>({ key });
  useEffect(() => {
    let live = true;
    work().then(
      (value) => live && setState({ key, value }),
      () => live && setState({ key, failed: true })
    );
    return () => {
      live = false;
    };
    // `work` is rebuilt every render; the key says when the job is a new one.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.key === key && state.failed) throw new Error('The preview could not be built.');
  return state.key === key ? state.value : undefined;
}
