import { useEffect, useRef, useState } from 'react';
import type { FileVersion, UploadFileResponse } from '@living-wiki/contracts';
import { errorMessage } from '../lib/api.js';
import { loadSession } from '../lib/session.js';
import { Button } from '../components/ui.js';
import { gridcraftUrl, isSpreadsheetSave, parseGridCraftMessage } from './gridcraft.js';

export interface GridCraftEditorProps {
  bytes: ArrayBuffer;
  version: FileVersion;
  onSave: (file: File) => Promise<UploadFileResponse>;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}

interface FailedCopy {
  name: string;
  bytes: ArrayBuffer;
}

/** Hands the bytes to a temporary link without putting the session token in the URL. */
function downloadBytes(name: string, bytes: ArrayBuffer): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export default function GridCraftEditor({ bytes, version, onSave, onDirtyChange, onClose }: GridCraftEditorProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const mounted = useRef(true);
  const bytesRef = useRef(bytes);
  const versionRef = useRef(version);
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const dirtyRef = useRef(false);
  const dirtyEpoch = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  const [opened, setOpened] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(0);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [downloadedName, setDownloadedName] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState<FailedCopy | null>(null);

  bytesRef.current = bytes;
  versionRef.current = version;
  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;

  const parentDirty = dirty || saving > 0 || saveFailed;

  useEffect(() => {
    onDirtyChangeRef.current?.(parentDirty);
  }, [parentDirty]);

  useEffect(() => {
    mounted.current = true;

    const queueSave = (fileBytes: ArrayBuffer, currentVersion: FileVersion) => {
      const epoch = dirtyEpoch.current;
      setSaving((count) => count + 1);
      const task = saveChain.current.then(async () => {
        if (!mounted.current) return;
        try {
          const response = await onSaveRef.current(
            new File([fileBytes], currentVersion.fileName, { type: currentVersion.mimeType }),
          );
          if (!mounted.current) return;
          setSavedVersion(response.version.number);
          setSaveError(null);
          setDownloadedName(null);
          setFailedCopy(null);
          setSaveFailed(false);
          // A later edit sends its own dirty:true; only a save with no newer edit clears the parent.
          if (dirtyEpoch.current === epoch) {
            dirtyRef.current = false;
            setDirty(false);
          }
        } catch (error) {
          if (!mounted.current) return;
          setSaveError(errorMessage(error));
          setSaveFailed(true);
          setFailedCopy({ name: currentVersion.fileName, bytes: fileBytes });
        } finally {
          if (mounted.current) setSaving((count) => Math.max(0, count - 1));
        }
      });
      saveChain.current = task.catch(() => undefined);
    };

    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = parseGridCraftMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case 'ready': {
          setOpened(true);
          setStartError(null);
          const copy = bytesRef.current.slice(0);
          frame.current?.contentWindow?.postMessage(
            { type: 'gridcraft:open', name: versionRef.current.fileName, bytes: copy },
            '*',
            [copy],
          );
          break;
        }
        case 'dirty':
          dirtyRef.current = message.dirty;
          dirtyEpoch.current += 1;
          setDirty(message.dirty);
          if (message.dirty) {
            setSaveError(null);
            setDownloadedName(null);
          }
          break;
        case 'save': {
          const currentVersion = versionRef.current;
          if (!isSpreadsheetSave(message.name, currentVersion.fileName)) {
            const name = message.name.trim() || currentVersion.fileName;
            downloadBytes(name, message.bytes);
            setDownloadedName(name);
            setSaveError(null);
            setSaveFailed(true);
            setFailedCopy({ name, bytes: message.bytes });
            break;
          }
          queueSave(message.bytes, currentVersion);
          break;
        }
        case 'failed':
          setStartError(`GridCraft couldn't start: ${message.error}.`);
          break;
      }
    };

    window.addEventListener('message', receive);
    return () => {
      mounted.current = false;
      window.removeEventListener('message', receive);
      onDirtyChangeRef.current?.(false);
    };
  }, []);

  const status = startError
    ? startError
    : saving > 0
      ? 'Saving…'
      : saveError
        ? `Couldn't save the workbook. ${saveError} Download a copy instead.`
        : downloadedName
          ? `Downloaded a copy of ${downloadedName}.`
          : dirty
            ? 'Unsaved changes'
            : savedVersion !== null
              ? `Saved as version ${savedVersion}.`
              : opened
                ? `Editing ${version.fileName}. Press Ctrl+S to save a new version.`
                : 'Loading editor…';

  const back = () => {
    if (parentDirty && !window.confirm('Discard unsaved spreadsheet changes?')) return;
    onClose();
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm text-muted">
          {status}
        </p>
        {failedCopy && (
          <Button variant="secondary" className="h-8 px-2.5 py-1 text-xs" onClick={() => downloadBytes(failedCopy.name, failedCopy.bytes)}>
            Download a copy
          </Button>
        )}
        <Button variant="secondary" className="h-8 px-2.5 py-1 text-xs" onClick={back}>
          Back to preview
        </Button>
      </div>
      <iframe
        ref={frame}
        title={`${version.fileName} spreadsheet editor`}
        src={gridcraftUrl(loadSession()?.user.name)}
        sandbox="allow-scripts"
        allow="clipboard-read; clipboard-write"
        className="h-[70vh] min-h-[520px] w-full"
      />
    </div>
  );
}
