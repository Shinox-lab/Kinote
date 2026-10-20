import { useMemo } from 'react';
import { parseCsvRows } from '../lib/tablePreview.js';
import { PreviewTable } from './PreviewTable.js';

/** A CSV file as a table: the first 1,000 rows, the first row as column titles. */
export default function CsvViewer({ bytes, name }: { bytes: ArrayBuffer; name: string }) {
  const { rows, totalRows, truncated } = useMemo(() => parseCsvRows(new TextDecoder('utf-8').decode(bytes)), [bytes]);
  if (rows.length === 0) return <p className="text-sm text-muted">This file has no rows.</p>;
  return (
    <div className="flex flex-col gap-2">
      <PreviewTable rows={rows} header caption={`Rows of ${name}`} />
      {truncated && (
        <p className="text-xs text-muted">
          Showing the first {rows.length.toLocaleString('en-US')} of {totalRows.toLocaleString('en-US')} rows. Download the file to see the rest.
        </p>
      )}
    </div>
  );
}
