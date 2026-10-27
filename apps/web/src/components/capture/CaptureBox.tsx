import { useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { CAPTURE_MAX, SHAPE_OPTIONS } from '../../lib/capture.js';
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
 * where to limit it to, and Send. Opening Capture from a space or page
 * presets the limit to it.
 */
export function CaptureBox({ preset }: { preset: { space?: string; page?: string } }) {
  const id = useId();
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(preset.page ? `page:${preset.page}` : preset.space ? `space:${preset.space}` : '');
  const [shape, setShape] = useState<(typeof SHAPE_OPTIONS)[number]['value']>('auto');
  const { data: spaces } = useSpaces();
  const { data: page } = usePage(preset.page);
  const refresh = useRefresh();
  // A second click can land before the button re-renders as disabled: one send per text.
  const sending = useRef(false);
  const send = useMutation({
    mutationFn: () => api.createCapture({ text, shape, ...scopeBody(limit) }),
    onSuccess: () => {
      setText('');
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
        if (sending.current || over || text.trim() === '') return;
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
          <Button type="submit" disabled={over || text.trim() === '' || send.isPending}>
            Send
          </Button>
        </div>
      </div>
      <ErrorNote error={send.error} />
    </form>
  );
}
