import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type * as Y from 'yjs';
import { FIELDS_MAP, validFields, type Choice, type Collection } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { emptyFieldCount, nextChoiceColor } from '../../lib/fields.js';
import { useTenantKey } from '../../lib/queries.js';
import { useFieldNames } from '../../lib/fieldNames.js';
import { FieldEditor, FieldValue } from './FieldEditor.js';

/** The page document's `fields` map as plain values, re-read whenever anyone changes it. */
function useFieldsMap(ydoc: Y.Doc | null): Record<string, unknown> {
  const cache = useRef<{ doc: Y.Doc | null; version: number; value: Record<string, unknown> }>({ doc: null, version: -1, value: {} });
  const version = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!ydoc) return () => {};
      const map = ydoc.getMap(FIELDS_MAP);
      const on = () => {
        version.current += 1;
        notify();
      };
      map.observe(on);
      return () => map.unobserve(on);
    },
    [ydoc]
  );
  const snapshot = () => {
    const c = cache.current;
    if (c.doc !== ydoc || c.version !== version.current) {
      cache.current = { doc: ydoc, version: version.current, value: ydoc ? (ydoc.getMap(FIELDS_MAP).toJSON() as Record<string, unknown>) : {} };
    }
    return cache.current.value;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * A row's fields under its title (spec C5), read from and written to the live
 * page document, so other people see changes as they happen and collab
 * attributes them. Readers see values only. Empty fields fold away behind
 * "N empty fields".
 */
export function FieldsPanel({
  pageId,
  ydoc,
  collection,
  canEdit,
  canEditFields,
}: {
  pageId: string;
  ydoc: Y.Doc | null;
  collection: Collection;
  canEdit: boolean;
  /** Whether choices may be added (editor of the collection's space). */
  canEditFields: boolean;
}) {
  const raw = useFieldsMap(ydoc);
  const values = useMemo(() => validFields(collection.fields, raw), [collection.fields, raw]);
  const names = useFieldNames(pageId, collection.fields, [values]);
  const [showEmpty, setShowEmpty] = useState(false);
  const qc = useQueryClient();
  const pageKey = useTenantKey('page', pageId);
  if (collection.fields.length === 0) return null;

  const empty = emptyFieldCount(collection.fields, values);
  const shown = collection.fields.filter((f) => showEmpty || f.id in values);

  const write = (fieldId: string, value: unknown) => {
    if (!ydoc || !canEdit) return;
    const map = ydoc.getMap(FIELDS_MAP);
    ydoc.transact(() => {
      if (value === null || value === undefined) map.delete(fieldId);
      else map.set(fieldId, value);
    });
  };
  const addChoice = async (fieldId: string, name: string): Promise<Choice | null> => {
    const def = collection.fields.find((f) => f.id === fieldId);
    if (!def || !canEditFields) return null;
    try {
      const updated = await api.updateField(collection.id, fieldId, {
        add_choice: { name, color: nextChoiceColor(def.options.choices ?? []) },
      });
      await qc.invalidateQueries({ queryKey: pageKey });
      return updated.options.choices?.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
    } catch {
      return null;
    }
  };

  return (
    <section aria-label="Fields" className="flex flex-col gap-0.5">
      <dl className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-center gap-x-3 gap-y-0.5">
        {shown.map((def) => (
          <div key={def.id} className="contents">
            <dt className="truncate py-1 text-sm text-muted">{def.name}</dt>
            <dd className="min-w-0">
              {canEdit ? (
                <FieldEditor
                  def={def}
                  value={values[def.id]}
                  names={names}
                  pageId={pageId}
                  onChange={(v) => write(def.id, v)}
                  onAddChoice={(name) => addChoice(def.id, name)}
                />
              ) : (
                <FieldValue def={def} value={values[def.id]} names={names} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {empty > 0 && (
        <button
          type="button"
          aria-expanded={showEmpty}
          onClick={() => setShowEmpty((v) => !v)}
          className="self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
        >
          {showEmpty ? 'Hide empty fields' : `${empty} empty ${empty === 1 ? 'field' : 'fields'}`}
        </button>
      )}
    </section>
  );
}
