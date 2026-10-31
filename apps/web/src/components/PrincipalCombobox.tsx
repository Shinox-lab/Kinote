import { useId, useMemo, useRef, useState } from 'react';
import { CloseIcon } from './icons.js';
import { Avatar } from './ui.js';

export interface PrincipalOption {
  type: 'user' | 'group' | 'agent';
  id: string;
  name: string;
  /** A second line: an email, a member count. Searched too. */
  detail?: string;
}

const SECTION: Record<PrincipalOption['type'], string> = { user: 'People', group: 'Groups', agent: 'Agents' };
const MAX_SHOWN = 50;

/**
 * Type to find a person or group, pick with the mouse or the arrow keys and Enter
 * (the ARIA combobox pattern). The caller owns the value, so it can clear it after use.
 */
export function PrincipalCombobox(props: {
  label: string;
  placeholder?: string;
  options: readonly PrincipalOption[];
  value: PrincipalOption | null;
  onChange: (value: PrincipalOption | null) => void;
  /** Shown when nothing is left to pick at all (not when a search finds nothing). */
  emptyText?: string;
}) {
  const { options, value, onChange } = props;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q
      ? options.filter((o) => o.name.toLowerCase().includes(q) || (o.detail ?? '').toLowerCase().includes(q))
      : options;
    // People first, then groups, then agents; the list order inside each kind is kept.
    const order = ['user', 'group', 'agent'] as const;
    return order.flatMap((t) => found.filter((o) => o.type === t)).slice(0, MAX_SHOWN);
  }, [options, query]);

  const pick = (option: PrincipalOption) => {
    onChange(option);
    setQuery('');
    setOpen(false);
  };
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {props.label}
      </label>
      {value ? (
        <div className="flex h-[38px] items-center gap-2 rounded-md border border-line bg-page pl-1.5 pr-1 max-md:h-11">
          <span className="scale-75">
            <Avatar name={value.name} id={value.id} kind={value.type} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-fg">
            {value.name}
            {value.detail && <span className="ml-1.5 text-xs text-muted">{value.detail}</span>}
          </span>
          <button
            type="button"
            aria-label={`Clear ${value.name}`}
            onClick={() => {
              onChange(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
            className="flex size-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
          >
            <CloseIcon />
          </button>
        </div>
      ) : (
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && matches.length > 0 ? optionId(active) : undefined}
          placeholder={props.placeholder ?? 'Search by name or email…'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && open && matches[active]) {
              e.preventDefault();
              pick(matches[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="w-full rounded-md border border-line bg-page px-3 py-2 text-sm text-fg placeholder:text-muted"
        />
      )}
      {open && !value && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={props.label}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          {matches.length === 0 && (
            <li role="presentation" className="px-2 py-2 text-sm text-muted">
              {options.length === 0 ? (props.emptyText ?? 'No one left to add.') : `No match for “${query.trim()}”.`}
            </li>
          )}
          {matches.map((o, i) => (
            <li key={`${o.type}:${o.id}`} role="presentation">
              {(i === 0 || matches[i - 1].type !== o.type) && (
                <p role="presentation" className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {SECTION[o.type]}
                </p>
              )}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 max-md:min-h-11 ${
                  i === active ? 'bg-hover' : ''
                }`}
              >
                <Avatar name={o.name} id={o.id} kind={o.type} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{o.name}</span>
                  {o.detail && <span className="block truncate text-xs text-muted">{o.detail}</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
