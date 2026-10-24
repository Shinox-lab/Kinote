import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button } from './ui.js';

/** Whether a drag carries files (and not, say, selected text). */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/**
 * A region that takes dropped files, with an "Upload" button for everyone who
 * does not drag (keyboard, touch). `target` names the place for the hint.
 */
export function DropZone({
  target,
  onFiles,
  children,
  buttonVariant = 'secondary',
  align = 'start',
}: {
  target: string;
  onFiles: (files: File[]) => void;
  children: ReactNode;
  buttonVariant?: 'primary' | 'secondary';
  align?: 'start' | 'end';
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border-2 border-dashed p-3 ${over ? 'border-accent bg-hover' : 'border-transparent'}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      <div className={`flex flex-wrap items-center gap-3 ${align === 'end' ? 'justify-end' : ''}`}>
        <Button variant={buttonVariant} onClick={() => input.current?.click()}>
          Upload files
        </Button>
        <p className="text-sm text-muted" aria-live="polite">
          {over ? `Drop to upload to ${target}` : `Or drop files here to add them to ${target}.`}
        </p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label={`Choose files to upload to ${target}`}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (picked.length > 0) onFiles(picked);
          }}
        />
      </div>
      {children}
    </div>
  );
}
