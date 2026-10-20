import { columnLabel } from '../lib/tablePreview.js';

/**
 * A scrolling table of text. Every cell is a React text node, so a cell that looks like markup or a
 * formula is just its characters. `letters` adds the spreadsheet's column letters and row numbers.
 */
export function PreviewTable({
  rows,
  header,
  letters = false,
  caption,
}: {
  rows: readonly (readonly string[])[];
  /** Treat the first row as column titles. */
  header: boolean;
  letters?: boolean;
  caption: string;
}) {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const head = header ? rows[0] : undefined;
  const body = header ? rows.slice(1) : rows;
  const offset = header ? 1 : 0;
  const CELL = 'border border-line px-2 py-1 text-left align-top text-sm';
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border border-line">
      <table className="min-w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          {letters && (
            <tr>
              <th scope="col" className={`${CELL} text-xs text-muted`} aria-label="Row" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} scope="col" className={`${CELL} text-xs font-medium text-muted`}>
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          )}
          {head && (
            <tr>
              {letters && <th scope="col" className={`${CELL} text-xs text-muted`}>1</th>}
              {Array.from({ length: width }, (_, c) => (
                <th key={c} scope="col" className={`${CELL} font-semibold`}>
                  {head[c] ?? ''}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {letters && (
                <th scope="row" className={`${CELL} text-xs font-normal text-muted`}>
                  {r + 1 + offset}
                </th>
              )}
              {Array.from({ length: width }, (_, c) => (
                <td key={c} className={`${CELL} whitespace-pre-wrap break-words`}>
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
