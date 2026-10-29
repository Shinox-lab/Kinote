import type { Group, Member } from '@kinote/contracts';
import { SelectField, TextField } from './ui.js';

export type PrincipalType = 'user' | 'group' | 'agent';

export interface Principal {
  type: PrincipalType;
  id: string;
}

const TYPE_LABEL: Record<PrincipalType, string> = { user: 'Person', group: 'Group', agent: 'Agent' };

/**
 * Picks a user (from the members), a group, or an agent (by id: the API has no agent list).
 * The caller owns the value, so it can reset it or read it when submitting.
 */
export function PrincipalPicker(props: {
  types: readonly PrincipalType[];
  value: Principal;
  onChange: (value: Principal) => void;
  members: readonly Member[];
  groups: readonly Group[];
}) {
  const { value, onChange } = props;
  const choices =
    value.type === 'user'
      ? props.members.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` }))
      : props.groups.map((g) => ({ value: g.id, label: g.name }));

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-32">
        <SelectField
          label="Type"
          value={value.type}
          options={props.types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
          onChange={(type) => onChange({ type, id: '' })}
        />
      </div>
      <div className="min-w-56 flex-1">
        {value.type === 'agent' ? (
          <TextField
            label="Agent id"
            value={value.id}
            onChange={(id) => onChange({ type: 'agent', id: id.trim() })}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            hint="The agent's id, as shown where it was created."
            required
          />
        ) : (
          <SelectField
            label={value.type === 'user' ? 'Person' : 'Group'}
            value={value.id}
            options={[{ value: '', label: 'Choose…' }, ...choices]}
            onChange={(id) => onChange({ type: value.type, id })}
          />
        )}
      </div>
    </div>
  );
}
