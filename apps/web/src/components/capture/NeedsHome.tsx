import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { NeedsHomeDocument, NeedsHomeItem } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { useNeedsHome, useNeedsHomeDocuments, useRefresh } from '../../lib/queries.js';
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

/** A document the engine could not place: a person picks its parent (and may retitle it), or routes it as updates. */
function DocumentItem({ item }: { item: NeedsHomeDocument }) {
  const [parent, setParent] = useState<{ id: string; title: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState(item.title);
  const refresh = useRefresh();
  const settled = () => {
    void refresh('needs-home');
    void refresh('captures');
    void refresh('capture', item.captureId);
  };
  const place = useMutation({
    mutationFn: () => api.placeDocument(item.captureId, { parent_page_id: parent!.id, title: title.trim() || item.title }),
    onSuccess: settled,
  });
  const asUpdates = useMutation({ mutationFn: () => api.routeAsUpdates(item.captureId), onSuccess: settled });
  const busy = place.isPending || asUpdates.isPending;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-page p-3">
      <p className="break-words text-sm font-medium text-fg">Where should “{item.title}” go?</p>
      {item.reason && <p className="text-xs text-muted">{item.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {item.options.map((o) => (
          <Button
            key={o.pageId}
            variant="secondary"
            aria-pressed={parent?.id === o.pageId}
            className={parent?.id === o.pageId ? '!border-[var(--routing)]' : ''}
            disabled={busy}
            onClick={() => setParent({ id: o.pageId, title: o.title })}
          >
            {o.title} <span className="text-muted">in {o.spaceName}</span>
          </Button>
        ))}
        <Button variant="secondary" disabled={busy} onClick={() => setPicking((v) => !v)}>
          Another page…
        </Button>
      </div>
      {picking && (
        <PagePicker
          label="Put it under"
          disabled={busy}
          onPick={(p) => {
            setParent(p);
            setPicking(false);
          }}
        />
      )}
      <label className="flex flex-col gap-1 text-xs text-muted">
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          className="rounded-md border border-line bg-page px-2 py-1.5 text-sm text-fg"
        />
      </label>
      {parent && <p className="text-xs text-muted">Under {parent.title}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !parent} onClick={() => place.mutate()}>
          Create page
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => asUpdates.mutate()}>
          Route as updates instead
        </Button>
      </div>
      <ErrorNote error={place.error ?? asUpdates.error} />
    </li>
  );
}

/** What the engine would not place on its own: documents waiting for a parent first, then facts. */
export function NeedsHome() {
  const { data: items } = useNeedsHome();
  const { data: documents } = useNeedsHomeDocuments();
  if ((!items || items.length === 0) && (!documents || documents.length === 0)) return null;
  return (
    <section aria-label="Needs a home" id="needs-home" className="flex flex-col gap-2 rounded-lg border border-review-line bg-review-bg p-4">
      <h2 className="text-sm font-semibold text-review-text">Needs a home</h2>
      <p className="text-xs text-muted">The routing engine was not sure where these belong.</p>
      <ul className="flex flex-col gap-2">
        {(documents ?? []).map((item) => (
          <DocumentItem key={item.captureId} item={item} />
        ))}
        {(items ?? []).map((item) => (
          <Item key={item.factId} item={item} />
        ))}
      </ul>
    </section>
  );
}
