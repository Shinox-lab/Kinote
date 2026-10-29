import { useRef, useState } from 'react';
import { fieldValueFits, type CollectionRow } from '@living-wiki/contracts';
import {
  TIMELINE_ZOOM,
  addDays,
  moveDate,
  resizeEnd,
  timelineBar,
  timelineDays,
  todayIso,
  type DateValue,
  type TimelineZoom,
  viewDateField,
} from '../../lib/views.js';
import type { LayoutProps } from './types.js';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const ROW_H = 32;

/** Monday on or before `day`. */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/**
 * The timeline layout (spec C7): bars from start to end of a date field.
 * Drag a bar to move it; drag its right edge to change its length. A date
 * with no end is a one-day bar.
 */
export function TimelineView(p: LayoutProps) {
  const def = viewDateField(p.collection.fields, p.view);
  const [zoom, setZoom] = useState<TimelineZoom>('month');
  const [start, setStart] = useState(() => addDays(mondayOf(todayIso()), -7));
  // While a bar is dragged: which, how, and how many days so far.
  const [drag, setDrag] = useState<{ rowId: string; mode: 'move' | 'resize'; days: number } | null>(null);
  const origin = useRef(0);
  if (!def) return <p className="text-sm text-muted">Add a date field to use a timeline.</p>;

  const { px } = TIMELINE_ZOOM[zoom];
  const days = timelineDays(start, zoom);
  const dateOf = (row: CollectionRow) => (fieldValueFits(def, row.values[def.id]) ? (row.values[def.id] as DateValue) : null);
  const shown = (row: CollectionRow): DateValue | null => {
    const d = dateOf(row);
    if (!d || drag?.rowId !== row.id) return d;
    return drag.mode === 'move' ? moveDate(d, drag.days) : resizeEnd(d, drag.days);
  };
  const today = todayIso();
  const step = Math.max(7, Math.floor(days.length / 2));

  const begin = (e: React.PointerEvent, row: CollectionRow, mode: 'move' | 'resize') => {
    if (!p.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = e.clientX;
    setDrag({ rowId: row.id, mode, days: 0 });
  };
  const track = (e: React.PointerEvent) => {
    if (drag) setDrag({ ...drag, days: Math.round((e.clientX - origin.current) / px) });
  };
  const finish = (row: CollectionRow) => {
    const d = dateOf(row);
    if (drag && d && drag.days !== 0) p.setValue(row.id, def.id, drag.mode === 'move' ? moveDate(d, drag.days) : resizeEnd(d, drag.days));
    setDrag(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" aria-label="Earlier" className="rounded px-2 py-0.5 hover:bg-hover" onClick={() => setStart((s) => addDays(s, -step))}>
          ‹
        </button>
        <button type="button" className="rounded px-2 py-0.5 text-xs text-muted hover:bg-hover" onClick={() => setStart(addDays(mondayOf(today), -7))}>
          Today
        </button>
        <button type="button" aria-label="Later" className="rounded px-2 py-0.5 hover:bg-hover" onClick={() => setStart((s) => addDays(s, step))}>
          ›
        </button>
        <select aria-label="Zoom" value={zoom} onChange={(e) => setZoom(e.target.value as TimelineZoom)} className="ml-2 rounded border border-line bg-surface px-1.5 py-0.5 text-xs">
          <option value="week">Weeks</option>
          <option value="month">Months</option>
          <option value="quarter">Quarters</option>
        </select>
      </div>
      <div className="flex overflow-hidden rounded-md border border-line text-xs">
        <ul aria-label="Pages" className="w-40 shrink-0 border-r border-line bg-page">
          <li className="h-7 border-b border-line" aria-hidden="true" />
          {p.rows.map((row) => (
            <li key={row.id} className="flex items-center border-b border-line px-2" style={{ height: ROW_H }}>
              <button type="button" onClick={() => p.open(row.id)} className="truncate text-left text-fg hover:underline">
                {row.title || 'Untitled'}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ width: days.length * px }} className="relative">
            <div className="flex h-7 border-b border-line">
              {days.map((d) => (
                <div
                  key={d}
                  style={{ width: px }}
                  className={`shrink-0 truncate border-l border-line/60 px-0.5 ${d === today ? 'font-semibold text-accent-text' : 'text-faint'}`}
                >
                  {zoom === 'week' || d.endsWith('-01') || new Date(`${d}T00:00:00Z`).getUTCDay() === 1 ? DAY_LABEL.format(new Date(`${d}T00:00:00Z`)) : ''}
                </div>
              ))}
            </div>
            {p.rows.map((row) => {
              const d = shown(row);
              const bar = d ? timelineBar(d, start, px) : null;
              return (
                <div key={row.id} className="relative border-b border-line" style={{ height: ROW_H }}>
                  {bar ? (
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${row.title || 'Untitled'}: ${d!.start}${d!.end ? ` to ${d!.end}` : ''}`}
                      onPointerDown={(e) => begin(e, row, 'move')}
                      onPointerMove={track}
                      onPointerUp={() => finish(row)}
                      onDoubleClick={() => p.open(row.id)}
                      onKeyDown={(e) => e.key === 'Enter' && p.open(row.id)}
                      style={{ left: bar.left, width: Math.max(bar.width, 6) }}
                      className={`absolute top-1 bottom-1 flex items-center truncate rounded bg-accent px-1.5 text-accent-fg ${p.canEdit ? 'cursor-grab' : ''}`}
                    >
                      <span className="truncate">{row.title || 'Untitled'}</span>
                      {p.canEdit && (
                        <span
                          aria-hidden="true"
                          onPointerDown={(e) => begin(e, row, 'resize')}
                          onPointerMove={track}
                          onPointerUp={() => finish(row)}
                          className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize"
                        />
                      )}
                    </div>
                  ) : (
                    p.canEdit && (
                      <button
                        type="button"
                        onClick={() => p.setValue(row.id, def.id, { start: today })}
                        className="absolute top-1 left-1 rounded px-1 text-faint hover:bg-hover hover:text-fg"
                      >
                        Set a date
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
