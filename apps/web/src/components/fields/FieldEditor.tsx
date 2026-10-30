import { useEffect, useState } from 'react';
import type { Choice, FieldDef, FieldNames, LinkTarget, Mentionable } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { CHOICE_CLASSES, fieldDisplay } from '../../lib/fields.js';

const INPUT =
  'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm text-fg hover:border-line focus:border-accent focus:outline-none max-md:min-h-11';

export interface FieldEditorProps {
  def: FieldDef;
  /** The value, already checked against the field (undefined when empty). */
  value: unknown;
  names: FieldNames;
  pageId: string;
  /** null clears the field. */
  onChange: (value: unknown) => void;
  /** Adds a choice to a select field (an editor of the collection), resolving to the new choice. */
  onAddChoice: (name: string) => Promise<Choice | null>;
}

/** A choice as a coloured chip. */
export function ChoiceChip({ choice }: { choice: Choice }) {
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-xs ${CHOICE_CLASSES[choice.color]}`}>{choice.name}</span>;
}

/** A field's value as read (no editor): chips for choices, words for the rest. */
export function FieldValue({ def, value, names }: { def: FieldDef; value: unknown; names: FieldNames }) {
  if (def.type === 'select' || def.type === 'multi_select') {
    const ids = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
    const chosen = (def.options.choices ?? []).filter((c) => ids.includes(c.id));
    if (chosen.length === 0) return <span className="text-sm text-faint">Empty</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {chosen.map((c) => (
          <ChoiceChip key={c.id} choice={c} />
        ))}
      </span>
    );
  }
  const text = fieldDisplay(def, value, names);
  return <span className={`text-sm ${text === null ? 'text-faint' : 'text-fg'}`}>{text ?? 'Empty'}</span>;
}

/** Text and number: saved when the box is left or Enter is pressed. */
function TextLike({ def, value, onChange }: Pick<FieldEditorProps, 'def' | 'value' | 'onChange'>) {
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const save = () => {
    const clean = draft.trim();
    if (clean === shown) return;
    if (clean === '') return onChange(null);
    if (def.type === 'number') {
      const n = Number(clean);
      if (Number.isFinite(n)) onChange(n);
      else setDraft(shown);
      return;
    }
    onChange(clean);
  };
  return (
    <input
      aria-label={def.name}
      type={def.type === 'number' ? 'number' : 'text'}
      inputMode={def.type === 'number' ? 'decimal' : undefined}
      value={draft}
      placeholder="Empty"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(shown);
      }}
      className={INPUT}
    />
  );
}

function DateField({ def, value, onChange }: Pick<FieldEditorProps, 'def' | 'value' | 'onChange'>) {
  const v = (value ?? null) as { start: string; end?: string } | null;
  const [withEnd, setWithEnd] = useState(Boolean(v?.end));
  useEffect(() => setWithEnd(Boolean(v?.end)), [v?.end]);
  const set = (start: string, end?: string) => {
    if (!start) return onChange(null);
    onChange(end && end >= start ? { start, end } : { start });
  };
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        aria-label={def.name}
        type="date"
        value={v?.start ?? ''}
        onChange={(e) => set(e.target.value, v?.end)}
        className={`${INPUT} w-auto`}
      />
      {withEnd ? (
        <>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <input
            aria-label={`${def.name} end`}
            type="date"
            min={v?.start}
            value={v?.end ?? ''}
            onChange={(e) => v?.start && set(v.start, e.target.value)}
            className={`${INPUT} w-auto`}
          />
        </>
      ) : (
        v?.start && (
          <button type="button" onClick={() => setWithEnd(true)} className="rounded px-1 text-xs text-muted hover:bg-hover">
            Add end date
          </button>
        )
      )}
    </span>
  );
}

/** A choice from the list, or a new one typed into "Add a choice". */
function ChoiceField({ def, value, onChange, onAddChoice }: Omit<FieldEditorProps, 'names' | 'pageId'>) {
  const choices = def.options.choices ?? [];
  const multi = def.type === 'multi_select';
  const chosen = multi ? ((value as string[] | undefined) ?? []) : value === undefined ? [] : [value as string];
  const [adding, setAdding] = useState('');
  const toggle = (id: string) => {
    if (!multi) return onChange(chosen[0] === id ? null : id);
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    onChange(next.length > 0 ? next : null);
  };
  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    const existing = choices.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const choice = existing ?? (await onAddChoice(name));
    setAdding('');
    if (choice && !chosen.includes(choice.id)) toggle(choice.id);
  };
  return (
    <div role="group" aria-label={def.name} className="flex flex-wrap items-center gap-1">
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={chosen.includes(c.id)}
          onClick={() => toggle(c.id)}
          className={`rounded px-1.5 py-0.5 text-xs max-md:min-h-11 ${
            chosen.includes(c.id) ? CHOICE_CLASSES[c.color] : 'text-muted hover:bg-hover'
          }`}
        >
          {c.name}
        </button>
      ))}
      <input
        aria-label={`Add a choice to ${def.name}`}
        value={adding}
        placeholder="Add a choice"
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void add()}
        className={`${INPUT} w-28`}
      />
    </div>
  );
}

/** People or pages: chips with a remove button, and a search box to add one. */
function PickerField({ def, value, names, pageId, onChange }: Omit<FieldEditorProps, 'onAddChoice'>) {
  const ids = (value as string[] | undefined) ?? [];
  const [query, setQuery] = useState('');
  // The list belongs to the box: it opens on focus and closes when focus leaves, so a table of these stays quiet.
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    let live = true;
    const q = query.trim();
    if (!open || (def.type === 'page' && q === '')) {
      setOptions([]);
      return;
    }
    const load =
      def.type === 'person'
        ? api.mentionable(pageId, q).then((list: Mentionable[]) => list.map((m) => ({ id: m.userId, label: m.name })))
        : api.linkTargets(q).then((list: LinkTarget[]) => list.map((t) => ({ id: t.id, label: t.title || 'Untitled' })));
    void load.catch(() => []).then((list) => live && setOptions(list.filter((o) => !ids.includes(o.id)).slice(0, 8)));
    return () => {
      live = false;
    };
  }, [open, query, def.type, pageId, ids.join(',')]);
  const label = (id: string) =>
    (def.type === 'person' ? names.users.get(id) : names.pages.get(id)) ??
    (def.type === 'person' ? 'Former member' : 'Page unavailable');
  return (
    <div className="relative flex flex-col gap-1">
      <span className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-xs text-fg">
            {label(id)}
            <button
              type="button"
              aria-label={`Remove ${label(id)}`}
              onClick={() => {
                const next = ids.filter((x) => x !== id);
                onChange(next.length > 0 ? next : null);
              }}
              className="text-muted hover:text-fg"
            >
              ×
            </button>
          </span>
        ))}
      </span>
      <input
        aria-label={`Add to ${def.name}`}
        value={query}
        placeholder={def.type === 'person' ? 'Add a person' : 'Add a page'}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className={INPUT}
      />
      {open && options.length > 0 && (query.trim() !== '' || def.type === 'person') && (
        <ul
          role="listbox"
          aria-label={`${def.name} options`}
          className="absolute left-0 right-0 top-full z-30 mt-1 min-w-[12rem] rounded border border-line bg-surface p-1 shadow-pop"
        >
          {options.map((o) => (
            <li key={o.id} role="option" aria-selected={false}>
              <button
                type="button"
                // Keeps focus in the box, so the list is still there when the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange([...ids, o.id]);
                  setQuery('');
                }}
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-hover"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The editor suited to a field's type (spec C5). */
export function FieldEditor(props: FieldEditorProps) {
  const { def, value, onChange } = props;
  switch (def.type) {
    case 'text':
    case 'number':
      return <TextLike def={def} value={value} onChange={onChange} />;
    case 'date':
      return <DateField def={def} value={value} onChange={onChange} />;
    case 'select':
    case 'multi_select':
      return <ChoiceField def={def} value={value} onChange={onChange} onAddChoice={props.onAddChoice} />;
    case 'person':
    case 'page':
      return <PickerField {...props} />;
    case 'checkbox':
      return (
        <input
          aria-label={def.name}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="m-1.5 size-4 accent-[var(--accent)]"
        />
      );
  }
}

