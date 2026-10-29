import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FIELD_TYPES, type Choice, type Collection, type FieldDef, type FieldType } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { FIELD_TYPE_LABELS, newChoiceId, nextChoiceColor, removalWarning } from '../../lib/fields.js';
import { Confirm } from '../lifecycle.js';
import { TitleInput } from '../sidebar/TitleInput.js';
import { Button, ErrorNote } from '../ui.js';
import { ChoiceChip } from './FieldEditor.js';

const ROW_BUTTON = 'rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-40 max-md:min-h-11';

type Pending = { kind: 'field'; def: FieldDef; pages: number } | { kind: 'choice'; def: FieldDef; choice: Choice; pages: number };

/** One field of the collection: rename, move, remove, and its choices for select fields. */
function FieldRow({
  collection,
  def,
  index,
  canEdit,
  onChanged,
  onRemove,
}: {
  collection: Collection;
  def: FieldDef;
  index: number;
  canEdit: boolean;
  onChanged: () => void;
  onRemove: (p: Pending) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [choiceName, setChoiceName] = useState('');
  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateField>[2]) => api.updateField(collection.id, def.id, body),
    onSuccess: () => {
      setRenaming(false);
      onChanged();
    },
  });
  const fields = collection.fields;
  const choices = def.options.choices ?? [];
  const choiceType = def.type === 'select' || def.type === 'multi_select';
  const addChoice = () => {
    const name = choiceName.trim();
    if (!name || choices.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
    update.mutate({ options: { choices: [...choices, { id: newChoiceId(), name, color: nextChoiceColor(choices) }] } });
    setChoiceName('');
  };
  const askRemove = async (choice?: Choice) => {
    const { pages } = await api.fieldUsage(collection.id, def.id, choice?.id);
    onRemove(choice ? { kind: 'choice', def, choice, pages } : { kind: 'field', def, pages });
  };

  return (
    <li className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <TitleInput title={def.name} onCancel={() => setRenaming(false)} onSave={(name) => update.mutate({ name })} />
        ) : (
          <span className="text-sm font-medium text-fg">{def.name}</span>
        )}
        <span className="text-xs text-muted">{FIELD_TYPE_LABELS[def.type]}</span>
        {canEdit && !renaming && (
          <span className="ml-auto flex gap-1">
            <button type="button" className={ROW_BUTTON} onClick={() => setRenaming(true)} aria-label={`Rename ${def.name}`}>
              Rename
            </button>
            <button
              type="button"
              className={ROW_BUTTON}
              disabled={index === 0}
              aria-label={`Move ${def.name} up`}
              onClick={() => update.mutate({ after: index >= 2 ? fields[index - 2]!.id : null })}
            >
              ↑
            </button>
            <button
              type="button"
              className={ROW_BUTTON}
              disabled={index === fields.length - 1}
              aria-label={`Move ${def.name} down`}
              onClick={() => update.mutate({ after: fields[index + 1]!.id })}
            >
              ↓
            </button>
            <button type="button" className={ROW_BUTTON} aria-label={`Remove ${def.name}`} onClick={() => void askRemove()}>
              Remove
            </button>
          </span>
        )}
      </div>
      {choiceType && (
        <div className="flex flex-wrap items-center gap-1">
          {choices.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-0.5">
              <ChoiceChip choice={c} />
              {canEdit && (
                <button type="button" aria-label={`Remove choice ${c.name}`} className={ROW_BUTTON} onClick={() => void askRemove(c)}>
                  ×
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <input
              aria-label={`New choice for ${def.name}`}
              placeholder="Add a choice"
              value={choiceName}
              onChange={(e) => setChoiceName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addChoice()}
              className="w-32 rounded border border-line bg-transparent px-1.5 py-0.5 text-xs max-md:min-h-11"
            />
          )}
        </div>
      )}
      <ErrorNote error={update.error} />
    </li>
  );
}

/**
 * The collection page's own fields (spec C5): what every sub-page gets. An
 * editor adds, renames, reorders and removes fields and their choices;
 * removing one says how many pages it clears first.
 */
export function FieldSetup({ collection, canEdit, onChanged }: { collection: Collection; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [pending, setPending] = useState<Pending | null>(null);
  const add = useMutation({
    mutationFn: () => api.addField(collection.id, { name: name.trim(), type }),
    onSuccess: () => {
      setName('');
      setType('text');
      setAdding(false);
      onChanged();
    },
  });

  const remove = async (p: Pending) => {
    if (p.kind === 'field') await api.removeField(collection.id, p.def.id);
    else {
      const choices = (p.def.options.choices ?? []).filter((c) => c.id !== p.choice.id);
      await api.updateField(collection.id, p.def.id, { options: { choices } });
    }
    setPending(null);
    onChanged();
  };

  return (
    <section aria-label="Fields" className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">Fields</h2>
        <span className="text-xs text-muted">Every page under {collection.title || 'this page'} has these.</span>
      </div>
      {collection.fields.length === 0 && <p className="text-sm text-muted">No fields yet.</p>}
      <ul className="flex flex-col">
        {collection.fields.map((def, index) => (
          <FieldRow
            key={def.id}
            collection={collection}
            def={def}
            index={index}
            canEdit={canEdit}
            onChanged={onChanged}
            onRemove={setPending}
          />
        ))}
      </ul>
      {pending && (
        <Confirm
          text={removalWarning(pending.kind === 'field' ? pending.def.name : pending.choice.name, pending.pages)}
          label={pending.kind === 'field' ? 'Remove field' : 'Remove choice'}
          run={() => remove(pending)}
          onCancel={() => setPending(null)}
        />
      )}
      {canEdit &&
        (adding ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) add.mutate();
            }}
          >
            <input
              aria-label="Field name"
              autoFocus
              value={name}
              placeholder="Field name"
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-line bg-transparent px-2 py-1 text-sm max-md:min-h-11"
            />
            <select
              aria-label="Field type"
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
              className="rounded border border-line bg-surface px-2 py-1 text-sm max-md:min-h-11"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={add.isPending || !name.trim()}>
              Add
            </Button>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <ErrorNote error={add.error} />
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={`${ROW_BUTTON} self-start text-sm`}>
            + Add a field
          </button>
        ))}
    </section>
  );
}
