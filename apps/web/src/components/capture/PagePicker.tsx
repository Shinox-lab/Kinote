import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { ErrorNote } from '../ui.js';

/** How long typing must pause before the picker searches. */
const PICKER_DEBOUNCE_MS = 250;

/**
 * Finds a page to file a fact on, through search: only indexed pages can be
 * picked, as only they are candidates for the routing engine too.
 */
export function PagePicker({
  label,
  onPick,
  disabled = false,
}: {
  label: string;
  onPick: (page: { id: string; title: string }) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['page-picker', query],
    queryFn: () => api.search({ query, limit: 10 }),
    enabled: query.length > 0,
  });
  const pages = [
    ...new Map(
      (results.data?.passages ?? [])
        .filter((p) => p.documentKind === 'page')
        .map((p) => [p.documentId, { id: p.documentId, title: p.versionTitle }])
    ).values(),
  ];
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-page p-2">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Type a page title or words on it"
        className="rounded-md border border-line bg-page px-2 py-1.5 text-sm text-fg"
      />
      <ErrorNote error={results.error} />
      {query && results.data && pages.length === 0 && <p className="text-xs text-muted">No indexed page matches.</p>}
      <ul className="flex flex-col">
        {pages.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              className="w-full rounded px-2 py-1 text-left text-sm text-fg hover:bg-hover disabled:opacity-50 max-md:min-h-11"
            >
              {p.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
