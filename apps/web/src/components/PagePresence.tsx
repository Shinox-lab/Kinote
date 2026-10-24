import { useEffect, useReducer } from 'react';
import type { ConnectionState } from '../lib/collab.js';
import { initials, presencePeople } from '../lib/presence.js';
import { loadSession } from '../lib/session.js';
import type { Live } from '../lib/useLivePage.js';

const DOT: Record<ConnectionState, string> = {
  connecting: 'bg-muted',
  connected: 'bg-success',
  offline: 'bg-dot-failed',
};

/**
 * Who else is here, from the live editor's awareness: a small connection dot,
 * up to three initials in stable tints (names on hover), then +N. When the
 * socket drops the dot is joined by Offline and Reconnect. The signed-in
 * person is left out; their own face is in the account row.
 */
export function PagePresence({
  live,
  state,
  onReconnect,
}: {
  live: Live | null;
  state: ConnectionState;
  onReconnect: () => void;
}) {
  const awareness = live?.provider.awareness ?? null;
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!awareness) return;
    const update = () => bump();
    awareness.on('change', update);
    awareness.on('update', update);
    return () => {
      awareness.off('change', update);
      awareness.off('update', update);
    };
  }, [awareness]);

  const selfId = loadSession()?.user.id ?? null;
  const people = awareness ? presencePeople(awareness.getStates(), selfId) : [];
  const shown = people.slice(0, 3);
  const more = people.length - shown.length;

  return (
    <div className="flex items-center gap-1.5">
      <span
        role="status"
        aria-label={`Presence: ${state}`}
        data-presence={state}
        className="flex items-center gap-1.5"
      >
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state]}`} />
        {state === 'offline' && <span className="text-xs text-muted">Offline</span>}
      </span>
      {state === 'offline' && (
        <button
          type="button"
          onClick={onReconnect}
          className="rounded px-1.5 py-0.5 text-xs font-medium text-accent-text hover:bg-hover"
        >
          Reconnect
        </button>
      )}
      {shown.length > 0 && (
        <ul aria-label="People on this page" className="flex items-center -space-x-1">
          {shown.map((person) => (
            <li key={person.id}>
              <span
                title={person.name}
                className="flex size-5 items-center justify-center rounded-full border border-line text-[9px] font-semibold"
                style={{ backgroundColor: person.tint, color: person.accent }}
              >
                {initials(person.name)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <span className="text-xs text-muted" title={people.slice(3).map((person) => person.name).join(', ')}>
          +{more}
        </span>
      )}
    </div>
  );
}
