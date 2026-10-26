import { useMutation } from '@tanstack/react-query';
import type { SuggestionSummary } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { suggestionAction } from '../../lib/capture.js';
import { useRefresh } from '../../lib/queries.js';
import { Button, ErrorNote } from '../ui.js';

const BLOCKED_BY: Record<SuggestionSummary['blockedBy'], string> = {
  removal: 'Removals always wait for a person',
  protection: 'Someone edited this block recently',
  conflict: 'Another source is cited here',
  no_edit_access: "The sender can't edit this space",
};

const KIND = { remove: 'Remove a block', replace: 'Replace a block', insert: 'Add a block' } as const;

/** One proposed change the routing engine was not allowed to make, with the person's choice. */
export function SuggestionEntry({ suggestion, onDone }: { suggestion: SuggestionSummary; onDone: () => void }) {
  const accept = useMutation({ mutationFn: () => api.acceptSuggestion(suggestion.id), onSuccess: onDone });
  const decline = useMutation({ mutationFn: () => api.declineSuggestion(suggestion.id), onSuccess: onDone });
  const busy = accept.isPending || decline.isPending;
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-dashed border-[var(--routing)] bg-[var(--routing-tint)] p-3 text-sm">
      <p className="font-medium text-fg">{KIND[suggestion.kind]}</p>
      <p className="text-xs text-muted">{BLOCKED_BY[suggestion.blockedBy]}</p>
      {suggestion.conflictWith && <p className="text-xs text-warn-text">Cited by {suggestion.conflictWith}, still valid</p>}
      {suggestion.proposedMarkdown && <p className="whitespace-pre-wrap break-words text-fg">{suggestion.proposedMarkdown}</p>}
      <p className="text-xs text-muted">Why: {suggestion.reason}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => accept.mutate()}>
          {suggestionAction(suggestion)}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => decline.mutate()}>
          Decline
        </Button>
      </div>
      <ErrorNote error={accept.error ?? decline.error} />
    </li>
  );
}

/** The page's open suggestions; each is decided here. */
export function SuggestionsPanel({ pageId, suggestions }: { pageId: string; suggestions: SuggestionSummary[] }) {
  const refresh = useRefresh();
  const done = () => {
    void refresh('page', pageId);
  };
  return (
    <section aria-label="Suggestions" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <h2 className="text-sm font-semibold text-fg">Suggestions from the routing engine</h2>
      <ul className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <SuggestionEntry key={s.id} suggestion={s} onDone={done} />
        ))}
      </ul>
    </section>
  );
}
