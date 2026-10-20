import { Suspense, lazy, type ComponentType } from 'react';
import type { FileVersion } from '@living-wiki/contracts';
import { Loading } from '../components/ui.js';
import { tooBigToPreview, viewerFor, type ViewerKind } from '../lib/viewers.js';
import { DownloadCard } from './DownloadCard.js';
import { ViewerBoundary } from './ViewerBoundary.js';
import { useFileBytes } from './useFileBytes.js';

/** What every viewer gets: the bytes, the version they belong to, and the page, sheet or slide to open on. */
export interface ViewerProps {
  bytes: ArrayBuffer;
  version: FileVersion;
  page?: number;
}

// Every viewer is its own chunk: its code (and the library behind it) loads only when a file of its type is opened.
const TextViewer = lazy(() => import('./TextViewer.js'));
const ImageViewer = lazy(() => import('./ImageViewer.js'));
const MarkdownViewer = lazy(() => import('./MarkdownViewer.js'));
const DocxViewer = lazy(() => import('./DocxViewer.js'));

const VIEWERS: Partial<Record<ViewerKind, ComponentType<ViewerProps>>> = {
  text: ({ bytes }) => <TextViewer bytes={bytes} />,
  markdown: ({ bytes }) => <MarkdownViewer bytes={bytes} />,
  docx: ({ bytes, version }) => <DocxViewer bytes={bytes} versionId={version.id} />,
  image: ({ bytes, version }) => <ImageViewer bytes={bytes} mimeType={version.mimeType} name={version.fileName} />,
};

function Bytes({ version, kind, page }: { version: FileVersion; kind: ViewerKind; page?: number }) {
  const { data, error, isPending } = useFileBytes(version.id);
  const View = VIEWERS[kind];
  if (isPending) return <Loading what="preview" />;
  if (error || !data || !View) return <DownloadCard version={version} reason="This file can't be previewed." />;
  return <View bytes={data.bytes} version={version} page={page} />;
}

/**
 * The preview of one file version: the viewer for its type, loaded on demand, inside a boundary
 * that falls back to a download when the file cannot be read (corrupt, too slow, too big).
 */
export function FileViewer({ version, page }: { version: FileVersion; page?: number }) {
  const kind = viewerFor(version.mimeType, version.sizeBytes);
  const fallback = <DownloadCard version={version} reason="This file can't be previewed." />;
  if (kind === 'download') {
    return (
      <DownloadCard
        version={version}
        reason={tooBigToPreview(version.sizeBytes) ? 'This file is too large to preview here.' : 'There is no preview for this type of file.'}
      />
    );
  }
  return (
    // Keyed by version: another version starts from a clean viewer.
    <ViewerBoundary key={version.id} fallback={fallback}>
      <Suspense fallback={<Loading what="preview" />}>
        <Bytes version={version} kind={kind} page={page} />
      </Suspense>
    </ViewerBoundary>
  );
}
