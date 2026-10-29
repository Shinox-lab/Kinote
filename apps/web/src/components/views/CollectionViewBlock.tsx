import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultView, parseViews, prefill, prefillTitle, type Choice, type CollectionPick, type CollectionRows, type View } from '@living-wiki/contracts';
import { api, ApiError } from '../../lib/api.js';
import { useFieldNames } from '../../lib/fieldNames.js';
import { nextChoiceColor } from '../../lib/fields.js';
import { createNamedPage } from '../../lib/newPage.js';
import { usePeek } from '../../lib/usePeek.js';
import { editViews, replaceView, todayIso, type ViewsEdit } from '../../lib/views.js';
import { useRefresh, useTenantKey, useWorkspace } from '../../lib/queries.js';
import { loadSession } from '../../lib/session.js';
import { useEditorPlace } from '../editor/place.js';
import { ErrorNote } from '../ui.js';
import { BoardView } from './BoardView.js';
import { CalendarView } from './CalendarView.js';
import { TableView } from './TableView.js';
import { TimelineView } from './TimelineView.js';
import { ViewToolbar } from './ViewToolbar.js';
import type { LayoutProps } from './types.js';

const FRAME = 'collection-view my-2 flex w-full flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-fg';

interface ViewProps {
  collectionId: string;
  title: string;
  views: string;
}

export interface ViewBlockProps extends ViewProps {
  /** The page holding the block can be edited: settings are saved for everyone. */
  editable: boolean;
  /** Saves the block's props, worked out from the ones saved now. */
  update: (edit: (saved: ViewProps) => Partial<ViewProps>) => void;
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Whether the element is on screen (true where that can't be told). */
function useOnScreen<E extends Element>(): [React.RefObject<E | null>, boolean] {
  const ref = useRef<E>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setOn(entry?.isIntersecting ?? true));
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, on];
}

/**
 * A collection view (spec C6–C8): tabs of views over a collection's rows. A
 * new block without a collection asks which one to show first.
 */
export function CollectionViewBlock(props: ViewBlockProps) {
  if (!props.collectionId) return <ViewChooser {...props} />;
  return <ViewBody {...props} />;
}

/** "Make this page a collection" or "Show an existing collection". */
function ViewChooser({ editable, update }: ViewBlockProps) {
  const place = useEditorPlace();
  const refresh = useRefresh();
  const [q, setQ] = useState('');
  const settledQ = useDebounced(q, 250);
  const { data: picks } = useQuery({
    queryKey: useTenantKey('collections', settledQ),
    queryFn: () => api.listCollections(settledQ),
    enabled: editable,
  });
  // The title is not stored: the block may sit where readers can't open the collection (it shows live, to readers who can).
  const choose = (c: { id: string }) => update(() => ({ collectionId: c.id, title: '', views: JSON.stringify([defaultView()]) }));
  const make = useMutation({
    mutationFn: () => api.createCollection(place!.pageId),
    onSuccess: (c) => {
      void refresh('page', place!.pageId);
      choose(c);
    },
  });
  if (!editable)
    return (
      <div className={FRAME} contentEditable={false} data-collection-view="">
        Collection view: not set up yet.
      </div>
    );
  return (
    <div className={FRAME} contentEditable={false} data-collection-view="">
      <p className="text-sm font-medium">Collection view</p>
      {place && (
        <button type="button" onClick={() => make.mutate()} disabled={make.isPending} className="self-start rounded-md border border-line px-2 py-1 text-sm hover:bg-hover">
          Make this page a collection
        </button>
      )}
      <ErrorNote error={make.error} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Show an existing collection</span>
        <input
          aria-label="Find a collection"
          value={q}
          placeholder="Find a collection"
          onChange={(e) => setQ(e.target.value)}
          className="rounded border border-line bg-transparent px-2 py-1"
        />
      </label>
      <ul aria-label="Collections" className="flex flex-col">
        {(picks ?? []).map((c: CollectionPick) => (
          <li key={c.id}>
            <button type="button" onClick={() => choose(c)} className="w-full rounded px-2 py-1 text-left text-sm hover:bg-hover">
              {c.icon ? `${c.icon} ` : ''}
              {c.title || 'Untitled'} <span className="text-xs text-muted">· {c.spaceName}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `values` with `changes` applied; null clears a field. */
const withValues = (values: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...values };
  for (const [id, v] of Object.entries(changes)) {
    if (v === null) delete next[id];
    else next[id] = v;
  }
  return next;
};

function ViewBody({ collectionId, views: viewsJson, editable, update }: ViewBlockProps) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const peek = usePeek();
  const refresh = useRefresh();
  const me = loadSession()?.user.id ?? null;
  const saved = parseViews(viewsJson);
  // A reader's changes (or unsaved ones) last for this visit only.
  const [local, setLocal] = useState<View[] | null>(null);
  const views = editable ? saved : (local ?? saved);
  const [activeId, setActiveId] = useState(views[0]!.id);
  const view = views.find((v) => v.id === activeId) ?? views[0]!;

  const changeViews = (edit: ViewsEdit) => {
    if (editable) update((saved) => ({ views: editViews(saved.views, edit) }));
    else setLocal(edit(views));
  };
  const changeView = (next: View) => changeViews(replaceView(next));

  // Others' edits show within 15 seconds while the view is on screen; off screen it waits for focus.
  const [frame, onScreen] = useOnScreen<HTMLDivElement>();
  const rowsKey = ['t', tenant.id, 'collection', collectionId, 'rows'];
  const today = todayIso();
  const { data, error, isPending } = useQuery({
    queryKey: [...rowsKey, view.filters, view.sorts, today],
    queryFn: () => api.collectionRows(collectionId, { filters: view.filters, sorts: view.sorts, today }),
    placeholderData: keepPreviousData,
    refetchInterval: onScreen ? 15_000 : false,
  });
  const fields = data?.collection.fields ?? [];
  const names = useFieldNames(collectionId, fields, (data?.rows ?? []).map((r) => r.values));
  const reload = () => qc.invalidateQueries({ queryKey: rowsKey });

  const set = useMutation({
    mutationFn: (a: { rowId: string; values: Record<string, unknown> }) => api.setPageFields(a.rowId, a.values),
    // The cell, card or bar moves at once; the reload puts it right if the save fails.
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: rowsKey });
      qc.setQueriesData<CollectionRows>({ queryKey: rowsKey }, (old) =>
        old && { ...old, rows: old.rows.map((r) => (r.id === a.rowId ? { ...r, values: withValues(r.values, a.values) } : r)) }
      );
    },
    onSettled: () => reload(),
  });
  const add = useMutation({
    mutationFn: async (extra: Record<string, unknown>) => {
      const page = await createNamedPage({ space_id: data!.spaceId, parent_id: collectionId, title: prefillTitle(view.filters) ?? 'Untitled' });
      const values = { ...prefill(fields, view.filters, me, today), ...extra };
      if (Object.keys(values).length > 0) await api.setPageFields(page.id, values);
      return page;
    },
    onSuccess: (page) => {
      void reload();
      void refresh('tree', data!.spaceId);
      peek.open(page.id);
    },
  });
  const addChoice = async (fieldId: string, name: string): Promise<Choice | null> => {
    const def = fields.find((f) => f.id === fieldId);
    if (!def) return null;
    try {
      const updated = await api.updateField(collectionId, fieldId, { add_choice: { name, color: nextChoiceColor(def.options.choices ?? []) } });
      await reload();
      return updated.options.choices?.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
    } catch {
      return null;
    }
  };

  if (error && !data) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <div className={FRAME} contentEditable={false} data-collection-view={collectionId}>
        <p className="text-sm text-muted">{gone ? "You can't open this collection, or it was removed." : 'This collection could not be loaded.'}</p>
      </div>
    );
  }

  const layout: LayoutProps | null = data
    ? {
        collection: data.collection,
        rows: data.rows,
        view,
        canEdit: data.canEdit,
        names,
        setValue: (rowId, fieldId, value) => set.mutate({ rowId, values: { [fieldId]: value } }),
        addChoice,
        open: (rowId) => peek.open(rowId),
        addRow: (values = {}) => add.mutate(values),
        changeView,
      }
    : null;

  return (
    <div ref={frame} className={FRAME} contentEditable={false} data-collection-view={collectionId}>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/w/$tenantSlug/p/$pageId"
          params={{ tenantSlug: tenant.slug, pageId: collectionId }}
          className="text-sm font-semibold text-fg hover:underline"
        >
          {data?.collection.title || 'Untitled'}
        </Link>
        {!editable && local && <span className="text-xs text-muted">Your changes to this view aren't saved.</span>}
      </div>
      <ViewToolbar
        views={views}
        view={view}
        fields={fields}
        names={names}
        onSelect={setActiveId}
        onChangeViews={(next, select) => {
          changeViews(next);
          if (select) setActiveId(select);
        }}
      />
      <ErrorNote error={set.error ?? add.error} />
      {isPending && !data && <p className="text-sm text-muted">Loading…</p>}
      {layout && view.layout === 'table' && <TableView {...layout} />}
      {layout && view.layout === 'board' && <BoardView {...layout} />}
      {layout && view.layout === 'calendar' && <CalendarView {...layout} />}
      {layout && view.layout === 'timeline' && <TimelineView {...layout} />}
      {data?.truncated && <p className="text-xs text-muted">Showing the first 1,000 pages</p>}
    </div>
  );
}
