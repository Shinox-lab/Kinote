import { useMemo, useState } from 'react';
import { SHEET_PREVIEW_COLUMNS, SHEET_PREVIEW_ROWS, capSheet, initialSheet } from '../lib/tablePreview.js';
import { VIEWER_TIMEOUT_MS, withTimeout } from '../lib/viewers.js';
import { Loading } from '../components/ui.js';
import { PreviewTable } from './PreviewTable.js';
import { useAsyncOrThrow } from './useAsyncOrThrow.js';

/** A workbook as tabs of tables: each sheet cut to 200 rows by 26 columns, values shown as text. */
export default function XlsxViewer({ bytes, versionId, name, page }: { bytes: ArrayBuffer; versionId: string; name: string; page?: number }) {
  const sheets = useAsyncOrThrow(versionId, () =>
    withTimeout(
      import('read-excel-file/browser').then(async (m) => {
        const read = (m as unknown as { default?: (input: ArrayBuffer) => Promise<{ sheet: string; data: unknown[][] }[]> }).default;
        if (!read) throw new Error('The spreadsheet reader is not available.');
        const all = await read(bytes);
        return all.map((s) => ({ name: s.sheet, ...capSheet(s.data) }));
      }),
      VIEWER_TIMEOUT_MS
    )
  );
  const first = useMemo(() => initialSheet(sheets?.length ?? 0, page), [sheets, page]);
  const [chosen, setChosen] = useState<number | null>(null);
  if (!sheets) return <Loading what="workbook" />;
  if (sheets.length === 0) return <p className="text-sm text-muted">This workbook has no sheets.</p>;
  const index = Math.min(chosen ?? first, sheets.length - 1);
  const sheet = sheets[index]!;
  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" aria-label={`Sheets of ${name}`} className="flex flex-wrap gap-1">
        {sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`sheet-tab-${i}`}
            aria-selected={i === index}
            aria-controls="sheet-panel"
            onClick={() => setChosen(i)}
            className={`rounded-md px-3 py-1.5 text-sm ${i === index ? 'bg-active font-medium' : 'text-muted hover:bg-hover'}`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="sheet-panel" aria-labelledby={`sheet-tab-${index}`}>
        {sheet.rows.length === 0 ? (
          <p className="text-sm text-muted">This sheet is empty.</p>
        ) : (
          <PreviewTable rows={sheet.rows} header={false} letters caption={`${sheet.name} of ${name}`} />
        )}
      </div>
      {sheet.truncated && (
        <p className="text-xs text-muted">
          Showing the first {SHEET_PREVIEW_ROWS} rows and {SHEET_PREVIEW_COLUMNS} columns of this sheet ({sheet.rowCount.toLocaleString('en-US')} rows,{' '}
          {sheet.colCount} columns). Download the file to see the rest.
        </p>
      )}
    </div>
  );
}
