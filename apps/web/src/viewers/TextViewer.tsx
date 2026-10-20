import { useMemo } from 'react';
import { TEXT_PREVIEW_CHARS, capText } from '../lib/viewers.js';

/** A text file as it is: UTF-8 in a wrapping `<pre>`, cut at a million characters. Never markup. */
export default function TextViewer({ bytes }: { bytes: ArrayBuffer }) {
  const { text, truncated } = useMemo(
    () => capText(new TextDecoder('utf-8').decode(bytes), TEXT_PREVIEW_CHARS),
    [bytes]
  );
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-4 font-mono text-sm">
        {text}
      </pre>
      {truncated && <p className="text-xs text-muted">Showing the first {TEXT_PREVIEW_CHARS.toLocaleString('en-US')} characters. Download the file to read the rest.</p>}
    </div>
  );
}
