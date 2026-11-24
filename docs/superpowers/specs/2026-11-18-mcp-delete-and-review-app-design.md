# MCP page delete and in-client review — design

Over MCP an agent can write and rename pages but cannot remove one, and everything it proposes for review
(waiting versions, suggestions) can only be decided in Kinote's web app. This adds:

1. Editor-level archive and restore for everyone (people and agents), not only space admins.
2. `kinote_delete`: an agent archives a page, or asks to, following the same review rules as its edits.
3. `kinote_create`, `kinote_move`, `kinote_restore` and `kinote_browse { archived }`: the agent arranges the
   page tree like a file system (§2b).
4. `kinote_review`: an MCP App panel (`ui://kinote/review`) where the agent's owner approves or rejects what is
   waiting, inside the AI client.

## Decisions taken with the user

- **Trust (option 1).** The panel's Approve/Reject buttons call app-only tools over the agent's MCP connection
  and act as the agent's owner. Kinote cannot tell the owner's click from the agent calling the tool; it relies
  on the host honouring `ui.visibility: ['app']`. A per-agent switch, **"Approve in your AI client"**, turns
  this off for an agent.
- **Delete is archive.** Nothing is ever removed for good; Restore brings a page back.
- **Archive and restore move from space admin to editor** for every page outside the Inbox (the Inbox rule is
  unchanged). This changes the web app for every editor, not only MCP.
- Defaults the user can still change: `kinote_delete` is its own tool (not an edit in `kinote_edit`); the panel
  lists everything the owner can decide, not only what this agent proposed (`mine_only` narrows it).

## 1. Editor-level archive and restore

- `archivePage` (`apps/api/src/routes/pages.ts`): `requireDocumentRole(..., 'editor')` (was `'admin'`). The
  `has_children` refusal stays. Files (`kind: 'file'`) follow the same rule, as they share `archivePage`.
- `restorePage`: editor or above on the page's space (was admin); in the Inbox, its creator, tenant owners and
  admins, as today.
- Web: `wiki.ts` `archive: live && rank >= RANK.editor`, `restorePage: archived && rank >= RANK.editor`;
  `fileUi.ts` `archive: live && rank >= RANK.editor`. A file's restore follows the same change.
- Archiving a **space** still needs a space admin.
- An agent's role is capped at editor, so an agent can now pass this check; whether it archives at once is
  decided by `kinote_delete` (§2).

## 2. `kinote_delete` (model-visible)

Scope `edit`, `writes: true`, limit `edit`. Input `{ page_id: string, reason: string (1..500) }`; `page_id`
resolves like `kinote_edit` (short id, slug or title ref).

Outcomes, in order:

| Condition | Result |
| --- | --- |
| Page not readable by the agent | refused: `Page not found` (as other tools) |
| Already archived | refused: `The page is already deleted.` |
| Agent below editor | refused: `no edit access: a person can delete it` |
| Live sub-pages | refused: `It has n sub-pages: delete or move them first.` |
| An open delete request already exists for the page | answers that request (no second one) |
| Agent has "always review" on, or the space has review required | **delete request** created (below) |
| Otherwise | archived now as the agent; text says `Deleted "<title>". A person can restore it from the page.` |

**Delete request** = a `suggestions` row with the new kind `archive`: `blockId`/`afterBlockId` null,
`proposedMarkdown` null, `reason` = the agent's reason, `blockedBy: 'no_edit_access'` reused as "waiting for a
person" (no new enum value), `proposedByType: 'agent'`, `proposedBy` the agent. Migration `0051`: widen the
`kind` check to include `archive` (Drizzle enum on `suggestions.kind` and the contracts' suggestion kind).

- **Accept** (`acceptSuggestion`): for `archive`, skip the block ops/snapshot path; run `archivePageTx` as the
  accepter under the page lock after `decidable` (which already needs editor, or reviewer when the space has
  review required, plus the existing self-approval rule). `has_children` at accept time leaves the suggestion
  open and answers 409 `has_children`. Audit `suggestion.accepted` with `kind: 'archive'`.
- **Decline**: unchanged.
- Archiving a page closes its other open suggestions as `stale` (so a page's archive request does not outlive it).
- Web: the page's suggestions list renders `archive` as "Delete this page — <reason>" with Accept/Decline.
- `toSuggestionSummary` / contracts: `kind` adds `'archive'`; no new fields.

Tool text for a request: `Asked to delete "<title>": waiting for a person (request <shortId>). They can decide it
in Kinote or with kinote_review.`

## 2b. Arranging the tree: `kinote_create`, `kinote_move`, `kinote_restore`

With browse, read, edit and delete, these let an agent treat the page tree like a file system. Pages are named
by id (from `kinote_browse`); there is no path addressing.

### `kinote_create` (model-visible)

Scope `edit`, `writes: true`, limit `edit`. Input `{ title: string (trimmed 1..200), under: string, markdown?:
string (≤ 1 000 000, default '') }`. `under` is a page ref (the new page is its child) or a space name/ID (top
level). No capture routing: the page goes exactly there.

- Runs `createPage` as the agent with `slug = pageSlug(title, <8 random hex>)`. `pageSlug(title, suffix)` is
  `slugFor` from `packages/core/src/routing/apply.ts`, renamed, exported and reused there.
- Then snapshots like `kinote_edit` (`takePageSnapshot`, `reason: 'agent'`, `forceReview` = the agent's
  "always review"), so it waits for review in the same cases as an edit.
- Refusals: `under` not found → as other tools; the agent below editor in that space → `no edit access: a
  person can add pages there`; the Inbox is never a target (agents cannot name it).
- Text: `Created "<title>" (<shortId>) under "<parent or space>" — waiting for review | indexing.`

### `kinote_move` (model-visible)

Scope `edit`, `writes: true`, limit `edit`. Input `{ page_id: string, under: string }`, `under` as in
`kinote_create`. Runs `movePage` as the agent (`target_space_id`, `target_parent_id`, `position` after the last
sibling). `movePage`'s rules stand: editor on the page and the target; a move to another space by a
non-reviewer (an agent always) sends the page back to review; `parent_cycle`, `parent_not_found`,
`page_archived`, `slug_taken` each map to one plain sentence. Moving is reversible, so "always review" does not
turn it into a request. Text: `Moved "<title>" under "<target>".` plus ` It waits for review again.` when it went
back to review.

### `kinote_restore` (model-visible)

Scope `edit`, `writes: true`, limit `edit`. Input `{ page_id: string }`, resolved among **archived** pages the
agent can read (`resolvePageRef(..., { archived: true })`). Runs `restorePage` as the agent (editor, §1). Text:
`Restored "<title>" under "<parent or the top of space>". It waits for review before it is searchable again.`
(restored versions stay withdrawn, as on the web).

### `kinote_browse { archived: true }`

Lists the archived pages of the chosen spaces (`getSpaceTree(..., archived = true)`), flat, by title, with
short ids and the date archived: `- <title> (<shortId>) — archived <date>`. Without `archived`, browse is
unchanged.

## 3. The review panel

### `kinote_review` (model-visible)

Scope `read`, `writes: false`. Input `{ page_id?: string, mine_only?: boolean }`. `_meta.ui.resourceUri =
"ui://kinote/review"`. Returns the same list as `kinote_review_list` (below) as text — one line per item:
`• <kind> on "<page>" by <proposer> — <summary>` — plus `structuredContent: { page_id: <resolved>|null,
mine_only }`. Text ends: `Kinote opened a review panel for your user. If none is shown, they can review at
<publicUrl>/w/<slug>/reviews.` The model never gets an approve tool.

### `kinote_review_list` (app-only, `ui.visibility: ['app']`)

Input `{ page_id?: string, mine_only?: boolean }`. Acts as **`actor.owner`** (the user), never the agent.
Returns `{ items: ReviewPanelItem[], can_decide_here: boolean }`, oldest first, at most 50:

```ts
type ReviewPanelItem = {
  type: 'version' | 'suggestion';
  id: string;
  page: { id: string; title: string; space: string };
  kind: 'version' | 'remove' | 'replace' | 'insert' | 'set_field' | 'archive';
  proposer: { type: 'user' | 'agent'; name: string };
  created_at: string;
  reason: string | null;
  before: string | null;   // markdown: the indexed page, or the addressed block / field value
  after: string | null;    // markdown: the version, or the proposed block / value; null for archive
  sub_pages?: number;      // archive only
  decidable: boolean;      // false: the owner may see it but someone else decides (self_approval)
  why_not?: string;        // e.g. "Your agent proposed this, so someone else decides it."
};
```

Sources: versions from `listReviewQueue(owner)` (its `canApprove` → `decidable`); open suggestions on pages the
owner can edit (the existing `listPageSuggestions` per page, or one query with the same gates), `decidable` by
the `decidable()` rule. `mine_only` keeps items proposed by this agent. A version's `before`/`after` are the
indexed version's markdown and the pending one's (each clipped to 20 000 chars, with "… (n more characters)").
`can_decide_here` = the agent's `approve_in_client`.

### `kinote_review_decide` (app-only)

Input `{ type: 'version'|'suggestion', id: string, decision: 'approve'|'reject', note?: string (≤ 500) }`.
Refused with `Approve this in Kinote: <link>` when the agent's `approve_in_client` is off. Otherwise as the
owner: `approveVersion` / `rejectVersion(note)` / `acceptSuggestion` / `declineSuggestion`. Answers
`{ ok: true, status }`, or `{ ok: false, message }` for an `AppError` (`self_approval`, `suggestion_not_open`,
`version_not_pending`, `has_children`, `forbidden`), never an MCP error, so the panel shows it on the item.
Audit events are the existing ones, with `payload.via: 'mcp_app'` and `agentId`.

### `approve_in_client` (agents)

Migration `0051` also adds `agents.approve_in_client boolean NOT NULL DEFAULT true`. API `PATCH` agent accepts
`approve_in_client`; the agent settings page (`apps/web/src/routes/admin/agents.tsx`) shows a switch
"Approve in your AI client" beside "Always review", with the help text "Your AI client's review panel can
approve and reject this agent's changes. Turn off to decide only in Kinote."

### The panel

Built like the upload panel (`apps/api/src/mcp/app/`): `reviewPanel.ts` (DOM) + `reviewLogic.ts` (pure state),
bundled by esbuild, served by `resources.ts` at `ui://kinote/review`.

- On the tool-input/result notification it calls `kinote_review_list` with the tool's arguments.
- One card per item: page title and space, kind, proposer, age, reason; a before/after view (removed lines
  red, added green, a line diff of the markdown); an archive card reads "Delete this page" and "n sub-pages".
- Buttons Approve / Reject (a version's Reject opens a one-line note). Disabled with `why_not` when not
  decidable; replaced by "Open in Kinote" when `can_decide_here` is false.
- After a decision the card shows the outcome ("Approved", "Rejected", or the error message) and the rest stay
  usable. A "Refresh" button reloads the list. Empty list: "Nothing is waiting for you."
- After each decision the panel sends the model a short `ui/message` context update: `Approved: replace on
  "Handoff".`, so the conversation knows.

## 4. Instructions and docs

`instructions.ts`: "To put a new page at an exact place, call kinote_create; to move one, kinote_move; to
remove one, kinote_delete with why (it may wait for a person); kinote_restore brings a deleted page back
(kinote_browse with archived lists them). When your user wants to see or decide what is waiting for review,
call kinote_review." README tools table: add `kinote_create`, `kinote_move`, `kinote_delete`,
`kinote_restore` and `kinote_review`; the lifecycle section says editors can archive and restore.

## Out of scope

Bulk approve; editing a suggestion before accepting it; captures waiting for a home (Inbox); deleting a space;
permanent delete.

## Testing

- `lifecycle.test.ts`: an editor archives and restores a page; a viewer cannot; Inbox rule unchanged; space
  archive still admin.
- `mcpDelete.test.ts`: archives at once (no review); request with "always review"; request when the space has
  review required; viewer refused; sub-pages refused; already archived; a second call answers the open request;
  accepting archives the page; accepting with a new child answers `has_children` and leaves it open; decline
  keeps the page; archiving closes the page's other open suggestions as stale.
- `mcpTree.test.ts`: create under a page and at a space's top level (title, parent, content, review detail);
  create refused for a viewer; move within a space; move to another space goes back to review; move into its
  own child refused; restore an archived page (and its parent gone → top level); browse `archived` lists it;
  restore of a live page refused as not found.
- `mcpReview.test.ts`: list as the owner shows a waiting version and a suggestion with before/after; `mine_only`;
  `decidable: false` with `why_not` for the owner's own agent in a review-required space; approve and reject a
  version; accept and decline a suggestion; `approve_in_client` off refuses decide and sets `can_decide_here`;
  a decision already taken answers `ok: false`; the review tools are app-only in `tools/list` `_meta`.
- `reviewPanel.test.ts`: logic for cards, the not-decidable state, outcomes, the empty state.
- `e2e/review-app.spec.ts`: the panel lists an agent's waiting edit; clicking Approve publishes it.
- Web: the agent settings switch; Archive shown to an editor.
