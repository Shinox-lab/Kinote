import { useEffect, useRef, useState } from 'react';
import type { CollectionRow, FieldDef } from '@kinote/contracts';
import { groupRows, tableGroupField, visibleFields } from '../../lib/views.js';
import { FieldEditor, FieldValue } from '../fields/FieldEditor.js';
import type { LayoutProps } from './types.js';

/** A row's title: opens the page in the side panel. */
export function RowTitle({ row, open }: { row: CollectionRow; open: (id: string) => void }) {
  return (
    <button type="button" onClick={() => open(row.id)} className="min-w-0 truncate text-left text-sm font-medium text-fg hover:underline">
      {row.icon ? `${row.icon} ` : ''}
      {row.title || 'Untitled'}
    </button>
  );
}

/**
 * One cell. Readers see the value. Editors see the value too, as one line, and get the field's editor once they click
 * it; it closes again when focus leaves the cell, so a table of select, date and person fields stays one row high.
 * A checkbox is its own editor and is always shown.
 */
export function Cell({ row, def, p }: { row: CollectionRow; def: FieldDef; p: LayoutProps }) {
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) box.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }, [editing]);

  const value = <FieldValue def={def} value={row.values[def.id]} names={p.names} />;
  if (!p.canEdit) return value;
  const editor = (
    <FieldEditor
      def={def}
      value={row.values[def.id]}
      names={p.names}
      pageId={row.id}
      onChange={(v) => p.setValue(row.id, def.id, v)}
      onAddChoice={(name) => p.addChoice(def.id, name)}
    />
  );
  if (def.type === 'checkbox') return editor;
  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`Edit ${def.name}`}
        onClick={() => setEditing(true)}
        className="block w-full min-w-[6rem] rounded px-1.5 py-1 text-left hover:bg-hover max-md:min-h-11"
      >
        {value}
      </button>
    );
  }
  return (
    <div
      ref={box}
      className="min-w-[12rem]"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
      }}
      onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
    >
      {editor}
    </div>
  );
}

/** The table layout (spec C7): Title then the shown fields, cells edited in place, optionally grouped. */
export function TableView(p: LayoutProps) {
  const fields = visibleFields(p.collection.fields, p.view.visible);
  const groupDef = tableGroupField(p.collection.fields, p.view);
  const groups = groupDef ? groupRows(p.rows, groupDef, p.names) : [{ key: '', label: '', rows: p.rows }];

  return (
    <div className="flex flex-col gap-1 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th scope="col" className="px-2 py-1 font-medium">
              Title
            </th>
            {fields.map((f) => (
              <th key={f.id} scope="col" className="px-2 py-1 font-medium" style={p.view.widths[f.id] ? { width: p.view.widths[f.id] } : undefined}>
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key} aria-label={groupDef ? g.label : undefined}>
            {groupDef && (
              <tr>
                <th scope="rowgroup" colSpan={fields.length + 1} className="px-2 pt-3 pb-1 text-left text-xs font-semibold text-muted">
                  {g.label} <span className="font-normal">{g.rows.length}</span>
                </th>
              </tr>
            )}
            {g.rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover/40">
                <td className="max-w-[16rem] px-2 py-1">
                  <RowTitle row={row} open={p.open} />
                </td>
                {fields.map((f) => (
                  <td key={f.id} className="px-1 py-0.5">
                    <Cell row={row} def={f} p={p} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {p.rows.length === 0 && <p className="px-2 text-sm text-muted">No pages{p.view.filters.length > 0 ? ' match these filters' : ' yet'}.</p>}
      {p.canEdit && (
        <button type="button" onClick={() => p.addRow()} className="self-start rounded px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg max-md:min-h-11">
          + New
        </button>
      )}
    </div>
  );
}
