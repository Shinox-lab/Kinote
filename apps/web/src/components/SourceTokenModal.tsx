import { useRef, useState } from 'react';
import { curlExamples } from '../lib/sources.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { Button } from './ui.js';

/**
 * Shows a new source token once. The secret lives only in this component's props, the page's state while it is open,
 * and the clipboard if the person copies it; closing removes it from the page for good.
 */
export function SourceTokenModal({ sourceName, token, onClose }: { sourceName: string; token: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  useFocusTrap(panel, true, onClose);
  const examples = curlExamples({ apiBase: window.location.origin, token });

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied('yes');
    } catch {
      // No clipboard permission: select the text so the person can copy it themselves.
      field.current?.select();
      setCopied('no');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-title"
        tabIndex={-1}
        className="flex max-h-full w-full max-w-2xl flex-col gap-4 overflow-auto rounded-lg border border-line bg-surface p-5 shadow-pop"
      >
        <h2 id="token-title" className="text-lg font-semibold">
          Token for {sourceName}
        </h2>
        <p className="rounded-md border border-line bg-hover px-3 py-2 text-sm">This token is shown once. It cannot be shown again.</p>
        <div className="flex gap-2">
          <input
            ref={field}
            readOnly
            aria-label="The new token"
            value={token}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-2 font-mono text-sm"
          />
          <Button variant="secondary" onClick={copy}>
            Copy
          </Button>
        </div>
        <p role="status" className="min-h-5 text-sm text-muted">
          {copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Could not copy automatically. The token is selected: copy it now.' : ''}
        </p>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Send a file</h3>
          <pre className="overflow-x-auto rounded-md border border-line bg-page p-3 text-xs">{examples.put}</pre>
          <h3 className="text-sm font-semibold">Remove a file</h3>
          <pre className="overflow-x-auto rounded-md border border-line bg-page p-3 text-xs">{examples.delete}</pre>
        </div>
        <div>
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
