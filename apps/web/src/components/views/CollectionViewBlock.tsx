import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultView, parseViews, prefill, type Choice, type CollectionPick, type View } from '@living-wiki/contracts';
import { api, ApiError } from '../../lib/api.js';
import { useFieldNames } from '../../lib/fieldNames.js';
import { nextChoiceColor } from '../../lib/fields.js';
import { createNamedPage } from '../../lib/newPage.js';
import { usePeek } from '../../lib/usePeek.js';
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

export interface ViewBlockProps {
  collectionId: string;
  title: string;
  views: string;
  /** The page holding the block can be edited: settings are saved for everyone. */
  editable: boolean;
  /** Saves the block's props. */
  update: (props: { collectionId?: string; title?: string; views?: string }) => void;
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
  const { data: picks } = useQuery({
    queryKey: useTenantKey('collections', q),
    queryFn: () => api.listCollections(q),
    enabled: editable,
  });
  const choose = (c: { id: string; title: string }) =>
    update({ collectionId: c.id, title: c.title, views: JSON.stringify([defaultView()]) });
  const make = useMutation({
    mutationFn: () => api.createCollection(place!.pageId),
    onSuccess: (c) => {
      void refresh('page', place!.pageId);
      choose(c);
    },
  });
  if (!editable) return <div className={FRAME} data-collection-view="">Collection view: not set up yet.</div>;
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

function ViewBody({ collectionId, title, views: viewsJson, editable, update }: ViewBlockProps) {
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

  const changeViews = (next: View[]) => {
    if (editable) update({ views: JSON.stringify(next) });
    else setLocal(next);
  };
  const changeView = (next: View) => changeViews(views.map((v) => (v.id === next.id ? next : v)));

  const rowsKey = ['t', tenant.id, 'collection', collectionId, 'rows'];
  const { data, error, isPending } = useQuery({
    queryKey: [...rowsKey, view.filters, view.sorts],
    queryFn: () => api.collectionRows(collectionId, { filters: view.filters, sorts: view.sorts }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const fields = data?.collection.fields ?? [];
  const names = useFieldNames(collectionId, fields, (data?.rows ?? []).map((r) => r.values));
  const reload = () => qc.invalidateQueries({ queryKey: rowsKey });

  const set = useMutation({
    mutationFn: (a: { rowId: string; values: Record<string, unknown> }) => api.setPageFields(a.rowId, a.values),
    onSettled: () => reload(),
  });
  const add = useMutation({
    mutationFn: async (extra: Record<string, unknown>) => {
      const page = await createNamedPage({ space_id: data!.spaceId, parent_id: collectionId, title: 'Untitled' });
      const values = { ...prefill(fields, view.filters, me), ...extra };
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
    <div className={FRAME} contentEditable={false} data-collection-view={collectionId}>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/w/$tenantSlug/p/$pageId"
          params={{ tenantSlug: tenant.slug, pageId: collectionId }}
          className="text-sm font-semibold text-fg hover:underline"
        >
          {data?.collection.title || title || 'Untitled'}
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
