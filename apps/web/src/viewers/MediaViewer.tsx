import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FileVersion } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/queries.js';
import { Loading } from '../components/ui.js';
import { DownloadCard } from './DownloadCard.js';

/**
 * An audio or video file in the browser's own player. The file is streamed from a short-lived signed link
 * (the player cannot send the bearer header), so it starts at once and can be scrubbed without downloading
 * the whole file. The link is fixed while the file plays; when it has expired (a long pause, then a seek)
 * the player errors once, a new link is fetched and playback resumes at the same position. A type the
 * browser cannot play (MKV, AVI, some MOV) falls back to the download.
 */
export default function MediaViewer({ version, kind }: { version: FileVersion; kind: 'audio' | 'video' }) {
  const { tenant } = useWorkspace();
  const player = useRef<HTMLMediaElement | null>(null);
  const resumeAt = useRef(0);
  const wasPlaying = useRef(false);
  const started = useRef(false);
  const [renewals, setRenewals] = useState(0);
  const [override, setOverride] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const link = useQuery({
    queryKey: ['t', tenant.id, 'mediaUrl', version.id],
    queryFn: () => api.mediaUrl(version.id),
    staleTime: Infinity,
    gcTime: 0,
  });
  if (link.isPending) return <Loading what="preview" />;
  if (link.error || !link.data || failed) {
    return <DownloadCard version={version} reason="This file can't be played in the browser." />;
  }

  const onError = async () => {
    // A file that never loaded gets one new link (to tell an expired link from a type the browser
    // cannot play); one that had been playing gets a new link whenever its old one runs out.
    if (!started.current && renewals >= 1) return setFailed(true);
    resumeAt.current = player.current?.currentTime ?? 0;
    wasPlaying.current = player.current ? !player.current.paused : false;
    setRenewals(renewals + 1);
    try {
      setOverride((await api.mediaUrl(version.id)).url);
    } catch {
      setFailed(true);
    }
  };
  const common = {
    ref: player as React.RefObject<never>,
    src: override ?? link.data.url,
    controls: true,
    preload: 'metadata' as const,
    onError,
    onLoadedMetadata: () => {
      started.current = true;
      if (resumeAt.current > 0 && player.current) {
        player.current.currentTime = resumeAt.current;
        resumeAt.current = 0;
        if (wasPlaying.current) void player.current.play().catch(() => undefined);
      }
    },
  };
  return kind === 'video' ? (
    <video key={`${version.id}:${renewals}`} {...common} className="mx-auto max-h-[75vh] w-full max-w-[960px] rounded-md bg-file-mat" />
  ) : (
    <audio key={`${version.id}:${renewals}`} {...common} className="mx-auto w-full max-w-[660px]" />
  );
}
