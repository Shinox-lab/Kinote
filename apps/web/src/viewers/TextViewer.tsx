import { useMemo } from 'react';
import { TEXT_PREVIEW_CHARS, capText } from '../lib/viewers.js';

/** A text file as it is: UTF-8 in a wrapping `<pre>`, cut at a million characters. Never markup. */
export default function TextViewer({ bytes, mono = false }: { bytes: ArrayBuffer; mono?: boolean }) {
  const { text, truncated } = useMemo(
    () => capText(new TextDecoder('utf-8').decode(bytes), TEXT_PREVIEW_CHARS),
    [bytes]
  );
  return (
    <div className="flex flex-col gap-2">
      <pre
        className={
          mono
            ? 'mx-auto max-h-[70vh] w-full max-w-[860px] overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.6]'
            : 'mx-auto max-h-[70vh] w-full max-w-[660px] overflow-auto whitespace-pre-wrap break-words font-sans text-[15.5px] leading-[1.72]'
        }
      >
        {text}
      </pre>
      {truncated && <p className="text-xs text-muted">Showing the first {TEXT_PREVIEW_CHARS.toLocaleString('en-US')} characters. Download the file to read the rest.</p>}
    </div>
  );
}
