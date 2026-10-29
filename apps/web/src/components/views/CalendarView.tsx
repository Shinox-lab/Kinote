import { useState } from 'react';
import { fieldValueFits, type CollectionRow } from '@living-wiki/contracts';
import { calendarWeeks, daysBetween, moveDate, todayIso, viewDateField, type DateValue } from '../../lib/views.js';
import type { LayoutProps } from './types.js';

const DRAG_TYPE = 'application/x-living-wiki-day';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const shiftMonth = (month: string, n: number) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

/**
 * The calendar layout (spec C7): a month of days on a date field; an item
 * with an end date shows on each of its days. Dragging moves its date
 * (keeping its length); undated items wait in a tray to be dragged in.
 */
export function CalendarView(p: LayoutProps) {
  const def = viewDateField(p.collection.fields, p.view);
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [over, setOver] = useState<string | null>(null);
  if (!def) return <p className="text-sm text-muted">Add a date field to use a calendar.</p>;

  const dateOf = (row: CollectionRow) => (fieldValueFits(def, row.values[def.id]) ? (row.values[def.id] as DateValue) : null);
  const undated = p.rows.filter((r) => !dateOf(r));
  const onDay = (dayIso: string) =>
    p.rows.filter((r) => {
      const d = dateOf(r);
      return d !== null && d.start <= dayIso && dayIso <= (d.end ?? d.start);
    });

  const drop = (e: React.DragEvent, target: string) => {
    e.preventDefault();
    setOver(null);
    try {
      const { rowId, from } = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { rowId: string; from: string | null };
      const row = p.rows.find((r) => r.id === rowId);
      if (!row) return;
      const current = dateOf(row);
      if (!current || from === null) p.setValue(row.id, def.id, { start: target });
      else if (from !== target) p.setValue(row.id, def.id, moveDate(current, daysBetween(from, target)));
    } catch {
      // Not one of ours.
    }
  };
  const item = (row: CollectionRow, from: string | null) => (
    <button
      key={`${row.id}:${from}`}
      type="button"
      draggable={p.canEdit}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ rowId: row.id, from }))}
      onClick={() => p.open(row.id)}
      className="truncate rounded bg-accent-soft px-1 py-0.5 text-left text-xs text-fg hover:underline"
    >
      {row.title || 'Untitled'}
    </button>
  );
  const today = todayIso();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-sm">
        <button type="button" aria-label="Previous month" className="rounded px-2 py-0.5 hover:bg-hover" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
          ‹
        </button>
        <span className="min-w-36 text-center font-medium">{MONTH.format(new Date(`${month}-01T00:00:00Z`))}</span>
        <button type="button" aria-label="Next month" className="rounded px-2 py-0.5 hover:bg-hover" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
          ›
        </button>
        <button type="button" className="rounded px-2 py-0.5 text-xs text-muted hover:bg-hover" onClick={() => setMonth(today.slice(0, 7))}>
          Today
        </button>
      </div>
      <div role="grid" aria-label="Calendar" className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-line bg-line text-xs">
        {WEEKDAYS.map((d) => (
          <div key={d} role="columnheader" className="bg-page px-1 py-0.5 text-muted">
            {d}
          </div>
        ))}
        {calendarWeeks(month)
          .flat()
          .map((dayIso) => (
            <div
              key={dayIso}
              role="gridcell"
              aria-label={dayIso}
              onDragOver={(e) => {
                if (!p.canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setOver(dayIso);
              }}
              onDragLeave={() => setOver((d) => (d === dayIso ? null : d))}
              onDrop={(e) => p.canEdit && drop(e, dayIso)}
              className={`group flex min-h-20 flex-col gap-0.5 p-1 ${over === dayIso ? 'bg-accent-soft' : 'bg-surface'} ${dayIso.slice(0, 7) === month ? '' : 'opacity-60'}`}
            >
              <span className={`flex items-center justify-between ${dayIso === today ? 'font-semibold text-accent-text' : 'text-muted'}`}>
                {Number(dayIso.slice(8))}
                {p.canEdit && (
                  <button
                    type="button"
                    aria-label={`New on ${dayIso}`}
                    onClick={() => p.addRow({ [def.id]: { start: dayIso } })}
                    className="invisible rounded px-1 text-muted hover:bg-hover group-hover:visible focus:visible"
                  >
                    +
                  </button>
                )}
              </span>
              {onDay(dayIso).map((r) => item(r, dayIso))}
            </div>
          ))}
      </div>
      {undated.length > 0 && (
        <section aria-label="No date" className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted">No date:</span>
          {undated.map((r) => item(r, null))}
        </section>
      )}
    </div>
  );
}
