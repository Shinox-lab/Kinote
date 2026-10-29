import type { Choice, Collection, CollectionRow, FieldNames, View } from '@kinote/contracts';

/** What every layout gets from the view block. */
export interface LayoutProps {
  collection: Collection;
  rows: CollectionRow[];
  view: View;
  /** Whether the viewer may change rows (an editor of the collection). */
  canEdit: boolean;
  names: FieldNames;
  /** Writes one value of one row (null clears it). */
  setValue: (rowId: string, fieldId: string, value: unknown) => void;
  /** Adds a choice to a select field, resolving to it. */
  addChoice: (fieldId: string, name: string) => Promise<Choice | null>;
  /** Opens a row in the side panel. */
  open: (rowId: string) => void;
  /** Makes a new row with these values (plus what the view's filters pin) and opens it. */
  addRow: (values?: Record<string, unknown>) => void;
  /** Changes this view's settings (saved for editors of the page, kept for this visit otherwise). */
  changeView: (view: View) => void;
}
