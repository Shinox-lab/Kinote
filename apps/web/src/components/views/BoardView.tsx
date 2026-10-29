import { useState } from 'react';
import type { CollectionRow, FieldDef } from '@living-wiki/contracts';
import { boardMove, groupRows, viewGroupField, visibleFields, type RowGroup } from '../../lib/views.js';
import { FieldValue } from '../fields/FieldEditor.js';
import { RowTitle } from './TableView.js';
import type { LayoutProps } from './types.js';

const DRAG_TYPE = 'application/x-living-wiki-row';

/** The board layout (spec C7): a column per value of the grouping field; dragging a card changes it. */
export function BoardView(p: LayoutProps) {
  const groupDef = viewGroupField(p.collection.fields, p.view);
  const [over, setOver] = useState<string | null>(null);
  if (!groupDef) {
    return <p className="text-sm text-muted">Pick a select, person or checkbox field to group the board by.</p>;
  }
  const groups = groupRows(p.rows, groupDef, p.names);
  const shown = visibleFields(p.collection.fields, p.view.visible)
    .filter((f) => f.id !== groupDef.id)
    .slice(0, 3);

  const move = (row: CollectionRow, from: string, to: string) => {
    const next = boardMove(groupDef, row.values[groupDef.id], from, to);
    if (next !== undefined) p.setValue(row.id, groupDef.id, next);
  };
  const drop = (e: React.DragEvent, to: string) => {
    e.preventDefault();
    setOver(null);
    try {
      const { rowId, from } = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { rowId: string; from: string };
      const row = p.rows.find((r) => r.id === rowId);
      if (row) move(row, from, to);
    } catch {
      // Not one of ours.
    }
  };

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {groups.map((g) => (
        <section
          key={g.key}
          aria-label={g.label}
          onDragOver={(e) => {
            if (!p.canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            setOver(g.key);
          }}
          onDragLeave={() => setOver((k) => (k === g.key ? null : k))}
          onDrop={(e) => p.canEdit && drop(e, g.key)}
          className={`flex w-60 shrink-0 flex-col gap-1.5 rounded-md p-1.5 ${over === g.key ? 'bg-accent-soft' : 'bg-page'}`}
        >
          <h3 className="flex items-center gap-1 px-1 text-xs font-semibold text-muted">
            {g.label} <span className="font-normal">{g.rows.length}</span>
          </h3>
          {g.rows.map((row) => (
            <Card key={row.id} row={row} group={g} groups={groups} shown={shown} p={p} move={move} />
          ))}
          {p.canEdit && (
            <button
              type="button"
              aria-label={`New in ${g.label}`}
              onClick={() => {
                const value = boardMove(groupDef, undefined, '', g.key);
                p.addRow(value !== undefined && value !== null ? { [groupDef.id]: value } : {});
              }}
              className="rounded px-1 py-0.5 text-left text-xs text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
            >
              + New
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

function Card({
  row,
  group,
  groups,
  shown,
  p,
  move,
}: {
  row: CollectionRow;
  group: RowGroup;
  groups: RowGroup[];
  shown: FieldDef[];
  p: LayoutProps;
  move: (row: CollectionRow, from: string, to: string) => void;
}) {
  return (
    <article
      aria-label={row.title || 'Untitled'}
      draggable={p.canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ rowId: row.id, from: group.key }));
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="flex flex-col gap-1 rounded-md border border-line bg-surface p-2 shadow-sm"
    >
      <RowTitle row={row} open={p.open} />
      {shown.map((f) => (
        <div key={f.id} className="flex items-center gap-1 text-xs">
          <span className="text-faint">{f.name}</span>
          <FieldValue def={f} value={row.values[f.id]} names={p.names} />
        </div>
      ))}
      {p.canEdit && (
        // Moving without dragging (keyboard, touch).
        <select
          aria-label={`Move ${row.title || 'Untitled'} to`}
          value={group.key}
          onChange={(e) => move(row, group.key, e.target.value)}
          className="self-start rounded border border-line bg-surface px-1 text-xs text-muted"
        >
          {groups.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
      )}
    </article>
  );
}
