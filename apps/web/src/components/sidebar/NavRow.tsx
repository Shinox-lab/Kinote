import type { ReactNode } from 'react';

/** Classes shared by every row of the sidebar (links and buttons alike). */
export const ROW =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg hover:bg-hover';
export const ROW_ACTIVE = `${ROW} bg-active font-medium`;

/** The inside of a sidebar row: an icon, the label, and an optional count. */
export function RowContent({
  icon,
  label,
  count,
  countLabel,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  /** Spoken after the number, e.g. "waiting". */
  countLabel?: string;
}) {
  return (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-sm text-muted">{icon}</span>
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-auto rounded-full bg-accent px-1.5 text-xs font-medium text-accent-fg">
          {count}
          {countLabel && <span className="sr-only"> {countLabel}</span>}
        </span>
      )}
    </>
  );
}
