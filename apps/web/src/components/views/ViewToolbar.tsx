import { useState } from 'react';
import {
  ME,
  OPS_BY_TYPE,
  TITLE_FIELD,
  VALUELESS_OPS,
  VIEW_LAYOUTS,
  defaultView,
  type FieldDef,
  type FieldNames,
  type FilterOp,
  type View,
  type ViewFilter,
  type ViewLayout,
} from '@living-wiki/contracts';
import { dateFields, groupableFields, viewDateField, viewGroupField } from '../../lib/views.js';

const CHIP = 'rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg max-md:min-h-11';
const SELECT = 'rounded border border-line bg-surface px-1.5 py-1 text-xs text-fg max-md:min-h-11';
const PANEL = 'flex flex-col gap-2 rounded-md border border-line bg-page p-2';

export const LAYOUT_LABELS: Record<ViewLayout, string> = { table: 'Table', board: 'Board', calendar: 'Calendar', timeline: 'Timeline' };

const OP_LABELS: Record<FilterOp, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  is: 'is',
  is_not: 'is not',
  is_empty: 'is empty',
  eq: '=',
  ne: '≠',
  lt: '<',
  gt: '>',
  before: 'is before',
  after: 'is after',
  this_week: 'is this week',
  this_month: 'is this month',
  next_month: 'is next month',
  checked: 'is checked',
  unchecked: 'is not checked',
};

const typeOf = (fields: FieldDef[], fieldId: string) =>
  fieldId === TITLE_FIELD ? ('title' as const) : fields.find((f) => f.id === fieldId)?.type;

/** The value box of one filter, suited to its field. */
function FilterValue({ filter, fields, names, onChange }: { filter: ViewFilter; fields: FieldDef[]; names: FieldNames; onChange: (value: unknown) => void }) {
  if (VALUELESS_OPS.includes(filter.op)) return null;
  const def = fields.find((f) => f.id === filter.fieldId);
  const label = 'Filter value';
  if (def?.type === 'select' || def?.type === 'multi_select') {
    return (
      <select aria-label={label} className={SELECT} value={String(filter.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {(def.options.choices ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    );
  }
  if (def?.type === 'person') {
    return (
      <select aria-label={label} className={SELECT} value={String(filter.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option value={ME}>Me</option>
        {[...names.users].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    );
  }
  if (def?.type === 'page') {
    return (
      <select aria-label={label} className={SELECT} value={String(filter.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {[...names.pages].map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
      </select>
    );
  }
  const kind = def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text';
  return (
    <input
      aria-label={label}
      type={kind}
      className={`${SELECT} w-32`}
      defaultValue={filter.value === undefined ? '' : String(filter.value)}
      onBlur={(e) => onChange(kind === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/**
 * A view's tabs and settings (spec C6): add, rename, delete views; layout;
 * filters (all must match), sorts, grouping or date field, and which fields
 * show.
 */
export function ViewToolbar({
  views,
  view,
  fields,
  names,
  onSelect,
  onChangeViews,
}: {
  views: View[];
  view: View;
  fields: FieldDef[];
  names: FieldNames;
  onSelect: (id: string) => void;
  onChangeViews: (next: View[], select?: string) => void;
}) {
  const [panel, setPanel] = useState<'filter' | 'sort' | 'fields' | 'view' | null>(null);
  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? null : p));
  const change = (next: View) => onChangeViews(views.map((v) => (v.id === next.id ? next : v)));
  const fieldOptions = [{ id: TITLE_FIELD, name: 'Title' }, ...fields];
  const groupable = groupableFields(fields);
  const dated = dateFields(fields);

  const addView = (layout: ViewLayout) => {
    const id = crypto.randomUUID().slice(0, 8);
    const next: View = {
      ...defaultView(layout, id),
      groupBy: layout === 'board' ? (groupable[0]?.id ?? null) : null,
      dateField: layout === 'calendar' || layout === 'timeline' ? (dated[0]?.id ?? null) : null,
    };
    onChangeViews([...views, next], id);
  };
  const setFilter = (i: number, f: ViewFilter) => change({ ...view, filters: view.filters.map((x, j) => (j === i ? f : x)) });

  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" aria-label="Views" className="flex flex-wrap items-center gap-1 border-b border-line">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={v.id === view.id}
            onClick={() => onSelect(v.id)}
            className={`-mb-px border-b-2 px-2 py-1 text-sm max-md:min-h-11 ${v.id === view.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {v.name}
          </button>
        ))}
        <select aria-label="Add a view" className={`${SELECT} ml-1`} value="" onChange={(e) => e.target.value && addView(e.target.value as ViewLayout)}>
          <option value="">+ Add a view</option>
          {VIEW_LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {LAYOUT_LABELS[l]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <select
          aria-label="Layout"
          className={SELECT}
          value={view.layout}
          onChange={(e) => {
            const layout = e.target.value as ViewLayout;
            change({
              ...view,
              layout,
              groupBy: layout === 'board' && !view.groupBy ? (groupable[0]?.id ?? null) : view.groupBy,
              dateField: (layout === 'calendar' || layout === 'timeline') && !view.dateField ? (dated[0]?.id ?? null) : view.dateField,
            });
          }}
        >
          {VIEW_LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {LAYOUT_LABELS[l]}
            </option>
          ))}
        </select>
        {(view.layout === 'table' || view.layout === 'board') && (
          <select
            aria-label="Group by"
            className={SELECT}
            value={view.layout === 'board' ? (viewGroupField(fields, view)?.id ?? '') : (view.groupBy ?? '')}
            onChange={(e) => change({ ...view, groupBy: e.target.value || null })}
          >
            {view.layout === 'table' && <option value="">No grouping</option>}
            {view.layout === 'board' && groupable.length === 0 && <option value="">No field to group by</option>}
            {groupable.map((f) => (
              <option key={f.id} value={f.id}>
                Group by {f.name}
              </option>
            ))}
          </select>
        )}
        {(view.layout === 'calendar' || view.layout === 'timeline') && (
          <select
            aria-label="Date field"
            className={SELECT}
            value={viewDateField(fields, view)?.id ?? ''}
            onChange={(e) => change({ ...view, dateField: e.target.value || null })}
          >
            {dated.length === 0 && <option value="">No date field</option>}
            {dated.map((f) => (
              <option key={f.id} value={f.id}>
                By {f.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" aria-expanded={panel === 'filter'} className={CHIP} onClick={() => toggle('filter')}>
          Filter{view.filters.length > 0 ? ` (${view.filters.length})` : ''}
        </button>
        <button type="button" aria-expanded={panel === 'sort'} className={CHIP} onClick={() => toggle('sort')}>
          Sort{view.sorts.length > 0 ? ` (${view.sorts.length})` : ''}
        </button>
        <button type="button" aria-expanded={panel === 'fields'} className={CHIP} onClick={() => toggle('fields')}>
          Fields
        </button>
        <button type="button" aria-expanded={panel === 'view'} className={CHIP} onClick={() => toggle('view')}>
          View
        </button>
      </div>

      {panel === 'filter' && (
        <div className={PANEL} aria-label="Filters" role="group">
          {view.filters.length === 0 && <p className="text-xs text-muted">No filters. Every page shows.</p>}
          {view.filters.map((f, i) => {
            const type = typeOf(fields, f.fieldId);
            return (
              <div key={i} className="flex flex-wrap items-center gap-1">
                <select
                  aria-label="Filter field"
                  className={SELECT}
                  value={f.fieldId}
                  onChange={(e) => {
                    const t = typeOf(fields, e.target.value) ?? 'text';
                    setFilter(i, { fieldId: e.target.value, op: OPS_BY_TYPE[t][0]! });
                  }}
                >
                  {fieldOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <select aria-label="Filter rule" className={SELECT} value={f.op} onChange={(e) => setFilter(i, { ...f, op: e.target.value as FilterOp })}>
                  {(type ? OPS_BY_TYPE[type] : []).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </select>
                <FilterValue
                  key={`${f.fieldId}:${f.op}`}
                  filter={f}
                  fields={fields}
                  names={names}
                  onChange={(value) => setFilter(i, { ...f, value })}
                />
                <button
                  type="button"
                  aria-label="Remove filter"
                  className={CHIP}
                  onClick={() => change({ ...view, filters: view.filters.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className={`${CHIP} self-start`}
            onClick={() => change({ ...view, filters: [...view.filters, { fieldId: TITLE_FIELD, op: 'contains', value: '' }] })}
          >
            + Add a filter
          </button>
        </div>
      )}

      {panel === 'sort' && (
        <div className={PANEL} aria-label="Sorts" role="group">
          {view.sorts.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1">
              <select
                aria-label="Sort field"
                className={SELECT}
                value={s.fieldId}
                onChange={(e) => change({ ...view, sorts: view.sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)) })}
              >
                {fieldOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Sort direction"
                className={SELECT}
                value={s.dir}
                onChange={(e) =>
                  change({ ...view, sorts: view.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              <button type="button" aria-label="Remove sort" className={CHIP} onClick={() => change({ ...view, sorts: view.sorts.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
          ))}
          {view.sorts.length < 5 && (
            <button
              type="button"
              className={`${CHIP} self-start`}
              onClick={() => change({ ...view, sorts: [...view.sorts, { fieldId: TITLE_FIELD, dir: 'asc' }] })}
            >
              + Add a sort
            </button>
          )}
        </div>
      )}

      {panel === 'fields' && (
        <div className={PANEL} aria-label="Shown fields" role="group">
          {fields.length === 0 && <p className="text-xs text-muted">This collection has no fields yet.</p>}
          {(() => {
            const shownIds = (view.visible ?? fields.map((f) => f.id)).filter((id) => fields.some((f) => f.id === id));
            const hiddenIds = fields.filter((f) => !shownIds.includes(f.id)).map((f) => f.id);
            const move = (id: string, delta: number) => {
              const next = [...shownIds];
              const at = next.indexOf(id);
              if (at + delta < 0 || at + delta >= next.length) return;
              [next[at], next[at + delta]] = [next[at + delta]!, next[at]!];
              change({ ...view, visible: next });
            };
            return [...shownIds, ...hiddenIds].map((id) => {
              const f = fields.find((x) => x.id === id)!;
              const shown = shownIds.includes(id);
              return (
                <div key={id} className="flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shown}
                      onChange={(e) => change({ ...view, visible: e.target.checked ? [...shownIds, id] : shownIds.filter((x) => x !== id) })}
                    />
                    {f.name}
                  </label>
                  {shown && (
                    <span className="ml-auto flex">
                      <button type="button" aria-label={`Move ${f.name} up`} className={CHIP} onClick={() => move(id, -1)}>
                        ↑
                      </button>
                      <button type="button" aria-label={`Move ${f.name} down`} className={CHIP} onClick={() => move(id, 1)}>
                        ↓
                      </button>
                    </span>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {panel === 'view' && (
        <div className={PANEL} aria-label="This view" role="group">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Name</span>
            <input
              aria-label="View name"
              defaultValue={view.name}
              className={`${SELECT} w-40`}
              onBlur={(e) => e.target.value.trim() && change({ ...view, name: e.target.value.trim().slice(0, 100) })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
          {views.length > 1 && (
            <button
              type="button"
              className={`${CHIP} self-start`}
              onClick={() => {
                const rest = views.filter((v) => v.id !== view.id);
                onChangeViews(rest, rest[0]!.id);
                setPanel(null);
              }}
            >
              Delete this view
            </button>
          )}
        </div>
      )}
    </div>
  );
}
