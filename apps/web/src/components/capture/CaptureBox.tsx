import { useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { CAPTURE_MAX, SHAPE_OPTIONS, captureFileProblem } from '../../lib/capture.js';
import { usePage, useRefresh, useSpaces } from '../../lib/queries.js';
import { Button, ErrorNote } from '../ui.js';

/** Where a capture may be limited to: `''` anywhere, `space:<id>` or `page:<id>`. */
function scopeBody(limit: string): { scope_space_id?: string; scope_page_id?: string } {
  if (limit.startsWith('space:')) return { scope_space_id: limit.slice(6) };
  if (limit.startsWith('page:')) return { scope_page_id: limit.slice(5) };
  return {};
}

/**
 * The box at the top of the Capture page: any text up to 20,000 characters,
 * a file to go with it (or alone), where to limit it to, and Send. Opening
 * Capture from a space or page presets the limit to it. The file is uploaded
 * to the sender's Inbox first; its text is routed once it has been read.
 */
export function CaptureBox({ preset }: { preset: { space?: string; page?: string } }) {
  const id = useId();
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(preset.page ? `page:${preset.page}` : preset.space ? `space:${preset.space}` : '');
  const [shape, setShape] = useState<(typeof SHAPE_OPTIONS)[number]['value']>('auto');
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: spaces } = useSpaces();
  const { data: page } = usePage(preset.page);
  const refresh = useRefresh();
  // A second click can land before the button re-renders as disabled: one send per text.
  const sending = useRef(false);
  const send = useMutation({
    mutationFn: async () => {
      let fileId: string | undefined;
      if (file) {
        const inbox = (spaces ?? []).find((s) => s.kind === 'inbox');
        const form = new FormData();
        form.append('space_id', inbox?.id ?? '');
        form.append('file', file, file.name);
        fileId = (await api.uploadFile(form)).document.id;
      }
      return api.createCapture({ text, shape, ...(fileId ? { file_id: fileId } : {}), ...scopeBody(limit) });
    },
    onSuccess: () => {
      setText('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      void refresh('tree');
      void refresh('captures');
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  const length = text.length;
  const over = length > CAPTURE_MAX;
  const writable = (spaces ?? []).filter((s) => s.kind !== 'inbox' && s.myRole !== 'viewer' && !s.archivedAt);

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.current || over || (text.trim() === '' && !file)) return;
        sending.current = true;
        send.mutate();
      }}
    >
      <label htmlFor={`${id}-text`} className="text-sm font-medium text-fg">
        What do you want to file?
      </label>
      <textarea
        id={`${id}-text`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={5}
        placeholder="Paste notes, a decision, a change… the routing engine files each fact on the right page."
        className="w-full resize-y rounded-md border border-line bg-page px-3 py-2 text-sm text-fg"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          id={`${id}-file`}
          type="file"
          className="sr-only"
          accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp,.gif"
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            const problem = picked ? captureFileProblem(picked) : null;
            setFileProblem(problem);
            setFile(problem ? null : picked);
            if (problem) event.target.value = '';
          }}
        />
        <label
          htmlFor={`${id}-file`}
          className="cursor-pointer rounded-md border border-line bg-page px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-hover max-md:min-h-11"
        >
          Attach a file
        </label>
        {file && (
          <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-hover px-2.5 py-1 text-xs text-fg">
            <span className="min-w-0 truncate">{file.name}</span>
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              onClick={() => {
                setFile(null);
                if (fileInput.current) fileInput.current.value = '';
              }}
              className="text-muted hover:text-fg"
            >
              ×
            </button>
          </span>
        )}
        {fileProblem && (
          <span role="alert" className="text-xs text-danger">
            {fileProblem}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <span>File as</span>
            <select
              aria-label="File as"
              value={shape}
              onChange={(event) => setShape(event.target.value as typeof shape)}
              className="rounded-md border border-line bg-page px-2 py-1.5 text-xs text-fg"
            >
              {SHAPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <span>Limit to</span>
            <select
              aria-label="Limit to"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              className="min-w-0 max-w-[16rem] rounded-md border border-line bg-page px-2 py-1.5 text-xs text-fg"
            >
              <option value="">Anywhere</option>
              {preset.page && <option value={`page:${preset.page}`}>This page: {page?.title ?? '…'}</option>}
              {writable.map((s) => (
                <option key={s.id} value={`space:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs tabular-nums ${over ? 'font-semibold text-danger' : 'text-muted'}`}>
            {length.toLocaleString('en-US')} / {CAPTURE_MAX.toLocaleString('en-US')}
          </span>
          <Button type="submit" disabled={over || (text.trim() === '' && !file) || send.isPending}>
            {send.isPending && file ? 'Uploading…' : 'Send'}
          </Button>
        </div>
      </div>
      <ErrorNote error={send.error} />
    </form>
  );
}
