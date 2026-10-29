import { useCallback, useEffect, useState } from 'react';
import type { FileVersion } from '@living-wiki/contracts';
import { XlsxViewer as ExtendXlsxViewer, useXlsxViewerController } from '@extend-ai/react-xlsx';
import { Loading } from '../components/ui.js';
import { initialSheet } from '../lib/tablePreview.js';
import { PREVIEW_LIMIT_BYTES, VIEWER_TIMEOUT_MS } from '../lib/viewers.js';
import { useResolvedTheme } from '../lib/useResolvedTheme.js';
import { DownloadCard } from './DownloadCard.js';

export default function XlsxViewer({ bytes, version, page }: { bytes: ArrayBuffer; version: FileVersion; page?: number }) {
  const [timedOut, setTimedOut] = useState(false);
  const onTimeout = useCallback(() => setTimedOut(true), []);
  if (timedOut) {
    return <DownloadCard version={version} reason="This workbook took too long to preview." />;
  }
  return <ExtendPreview bytes={bytes} version={version} page={page} onTimeout={onTimeout} />;
}

function ExtendPreview({
  bytes,
  version,
  page,
  onTimeout,
}: {
  bytes: ArrayBuffer;
  version: FileVersion;
  page?: number;
  onTimeout: () => void;
}) {
  const theme = useResolvedTheme();
  const controller = useXlsxViewerController({
    file: bytes,
    fileName: version.fileName,
    readOnly: true,
    useWorker: true,
    maxFileSizeBytes: PREVIEW_LIMIT_BYTES,
  });

  // Unmounting the child on timeout disposes the worker and aborts the parse; only the timer
  // belongs here.
  useEffect(() => {
    if (!controller.isLoading) return;
    const timer = window.setTimeout(onTimeout, VIEWER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [controller.isLoading, onTimeout, version.id]);

  // The controller has no initial-sheet prop. Set it after the workbook's sheets arrive;
  // everything else (default first sheet, clamping) is the existing initialSheet rule.
  useEffect(() => {
    if (controller.isLoading || controller.sheets.length === 0) return;
    controller.setActiveSheetIndex(initialSheet(controller.sheets.length, page));
  }, [controller.isLoading, controller.sheets.length, controller.setActiveSheetIndex, page, version.id]);

  return (
    <ExtendXlsxViewer
      controller={controller}
      height="clamp(420px, 70vh, 760px)"
      isDark={theme === 'dark'}
      experimentalCanvas={false}
      loadingState={<Loading what="workbook" />}
      errorState={<DownloadCard version={version} reason="This workbook can't be previewed." />}
      fileTooLargeState={<DownloadCard version={version} reason="This workbook is too large to preview here." />}
    />
  );
}
