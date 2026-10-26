import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { NeedsHomeItem } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { useNeedsHome, useRefresh } from '../../lib/queries.js';
import { Button, ErrorNote } from '../ui.js';
import { PagePicker } from './PagePicker.js';

function Item({ item }: { item: NeedsHomeItem }) {
  const [picking, setPicking] = useState(false);
  const refresh = useRefresh();
  const settled = () => {
    void refresh('needs-home');
    void refresh('captures');
    void refresh('capture', item.captureId);
  };
  const place = useMutation({
    mutationFn: (pageId: string) => api.placeFact(item.factId, { document_id: pageId }),
    onSuccess: settled,
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissFact(item.factId), onSuccess: settled });
  const busy = place.isPending || dismiss.isPending;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-page p-3">
      <p className="whitespace-pre-wrap break-words text-sm text-fg">{item.statement}</p>
      {item.reason && <p className="text-xs text-muted">{item.reason}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => setPicking((v) => !v)}>
          Place…
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => dismiss.mutate()}>
          Dismiss
        </Button>
      </div>
      {picking && <PagePicker label="Find a page" disabled={busy} onPick={(p) => place.mutate(p.id)} />}
      <ErrorNote error={place.error ?? dismiss.error} />
    </li>
  );
}

/** Facts the engine would not place on its own: a person picks the page, or drops the fact. */
export function NeedsHome() {
  const { data: items } = useNeedsHome();
  if (!items || items.length === 0) return null;
  return (
    <section aria-label="Needs a home" id="needs-home" className="flex flex-col gap-2 rounded-lg border border-review-line bg-review-bg p-4">
      <h2 className="text-sm font-semibold text-review-text">Needs a home</h2>
      <p className="text-xs text-muted">The routing engine was not sure where these belong.</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <Item key={item.factId} item={item} />
        ))}
      </ul>
    </section>
  );
}
