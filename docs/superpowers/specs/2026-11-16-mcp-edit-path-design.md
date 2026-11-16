# MCP edit path (build step 4) — design

Step 4 of the Kinote MCP spec (https://claude.ai/artifact/6Wyvb6h6PvxtrsBjwSS9fS): `kinote_edit` through the
collaboration layer, with suggestions for blocked edits. Capture (step 3) is for new information routed by
meaning; `kinote_edit` is for an agent that knows exactly which sentence is wrong.

## Decisions taken with the user

- Removals are always suggestions, as in capture.
- Accepting an agent's suggestion applies it as that agent; the audit log records who accepted.
- Field edits on collection rows ship now, with field values in `kinote_read`.
- The `edit` scope shows again on the Agents page and is offered at browser sign-in as a third opt-in box.

## 1. The tool

`kinote_edit(page_id, edits[])`, scope `edit`, `writes: true`, limit `edit` (30 calls a minute per agent).
At most 20 edits per call. `page_id` resolves like `kinote_read` (full id or 8+ hex prefix; files refused:
"kinote_edit changes pages, not files. Use kinote_capture to file what a file says.").

Each edit is exactly one of:

| Shape | Meaning |
| --- | --- |
| `{block_id, old, new}` | Replace the text `old` with `new` inside one top-level block |
| `{after_block_id, markdown}` | Insert blocks parsed from Markdown after a top-level block; `after_block_id: null` inserts at the top |
| `{remove_block_id}` | Propose removing a top-level block (always a suggestion) |
| `{field, value}` | Set a field of a collection row page; `field` is the field's name (case-insensitive) or id; `value` null clears it |

Rules per shape:

- **Block ids** are the 8-character ids `kinote_read` prints, or longer prefixes, or full ids; matched against
  top-level blocks only. A prefix matching two blocks is refused ("Block id "x" is ambiguous; give more characters").
- **Nested blocks** (an id that exists only below the top level), and top-level blocks of type table, image, file,
  video, audio, or a drawing are refused: "This block can't be edited with kinote_edit; use kinote_capture to
  propose the change." Inserting *after* such a block is allowed.
- **`old`/`new`**: `old` is non-empty and must occur exactly once in the block's own inline text (children
  excluded). Not found → refused "changed since you read it: read the section again"; found twice →
  refused "\"old\" appears 2 times in block x; quote more words". The replacement is applied inside the
  block's inline content so links and styles outside the replaced span survive; inserted text takes the
  styles (and link) of the run where `old` starts. `new` is plain text (may be empty to delete words).
  The block's type, props and children are kept.
- **`markdown`**: at most 10,000 characters, parsed with the existing `markdownBlocks`; empty → refused.
  New blocks get fresh ids.
- **`field`**: the page must be a collection row; unknown field → refused listing the field names; value
  checked with `fieldValueFits` → refused with the expected type.
- Edits in one call are planned against the same read of the page; two edits addressing the same block are
  refused ("one edit per block per call").

## 2. Outcomes

Before applying, the server flushes the page through collab and reads the live blocks. Each edit gets one
outcome:

1. **refused** — validation above, or the block is gone (`block not found: read the page again`), or the block
   no longer contains `old`. Nothing about that edit is saved. Other edits in the call still proceed.
2. **suggested** — saved as a suggestion for a person:
   - `remove_block_id` always (`blocked_by: 'removal'`);
   - a person (`block_activity.actor_type = 'user'`) changed the block or field within the space's
     `human_protection_seconds` (`protection`), reply text "suggested: <name> edited this block N minutes ago";
   - the agent cannot edit the page's space now: its grant is viewer, or `senderActor` reach (owner's current
     role) is below editor (`no_edit_access`), reply "suggested: no edit access".
3. **applied** — all remaining edits of the page go to collab in one `applyBlockOps` call as
   `{type:'agent', id: agentId}`, `source: 'agent'`, each replace/remove with `expectedText` = the block's
   `blockFullText` as read. If collab answers `block_changed` (someone typed between our read and the apply)
   every applied edit of that call is reported refused "changed since you read it". Then flush and
   `takePageSnapshot({reason: 'agent', actorType: 'agent', actorId: agentId, forceReview: agent.alwaysReview})`.
   Review follows the space; the reply says `applied · waiting for review` or `applied · indexing`.

An agent that cannot even view the page gets the normal not-found error (no suggestion).
A disabled agent or one whose owner left is refused by the existing token checks.

Audit: one `agent.edit` event per call with page id, counts per outcome, version id.

### Reply format

```
Product / Pricing · 3 edits
• b_33aa12 — applied · waiting for review
• after b_33aa12 — applied · waiting for review
• b_77cd90 — suggested: removals wait for a person
Link: <page link>
```

Refused lines read `• b_x — refused: <why>`. Page title goes inside the `dataBlock` containment like other
page text. When every edit was refused the result is `isError: true`.

## 3. Suggestions from agents

Migration `0048_agent_edits.sql`:

- `suggestions.proposed_by_type text check in ('user','agent')` and `suggestions.proposed_by uuid`, both null for
  existing rows (capture suggestions keep `capture_id`). No other schema change: snapshot reason `agent`
  already exists.

Behaviour:

- `SuggestionSummary` gains `proposedBy: {type, id, name} | null`; the Suggestions panel shows
  "Suggested by <agent name>" when set.
- `acceptSuggestion`: when `proposed_by_type = 'agent'` and that agent is still enabled, apply as that agent
  (collab actor and snapshot actor); otherwise as the Routing engine as today. Audit `suggestion.accepted`
  unchanged (actor = the person).
- `decidable`: in a review space without self-approval, the owner of the proposing agent may not decide it
  (`self_approval`), like a capture's sender.
- Agents never decide suggestions over MCP.

## 4. Read, scopes, limits, instructions

- `kinote_read` (section/full, and the outline header) on a collection row lists field values under the title:
  `Fields: Status: Done · Owner: Jane · Due: 2026-12-01`.
- `ToolDef.limit` gains `'edit'`, `MCP_EDIT_PER_MINUTE = 30`; suspension refuses via `writes: true`.
- `OAUTH_SCOPES = ['read','capture','edit']`; `OAuthDecision.allow` gains `edit: boolean` (default false),
  refused when the client didn't ask; capture or edit allowed → editor grants.
- Web: `OFFERED_SCOPES = ['read','capture','edit']`; the sign-in page shows "Also let it make precise edits
  (Edit)" when asked; `captureHasNowhereToFile` becomes "writes have nowhere to go" for Capture or Edit with
  wording naming both.
- Server instructions for an edit token: "Use kinote_edit for precise fixes: read the section first and quote
  the exact words to change. Check kinote_related so a fact written on several pages is fixed everywhere."
- README "Connect an agent" mentions the Edit scope.

## Testing

API (Vitest/PGlite, real collab test double as in capture tests):
applied replace keeps links/bold; insert after and at top; remove → suggestion; protection → suggestion with
the person's name; viewer grant → suggestion; owner lost edit → suggestion; `old` missing → refused; `old` twice
→ refused; nested/table block → refused; ambiguous prefix → refused; collab `block_changed` → refused; field
set, bad value refused, protected field → suggestion; always-review → waiting for review; suspended → refused;
scope `read` only → tool hidden/refused; limit 30/min; accept an agent suggestion → snapshot actor is the agent;
owner can't approve own agent's suggestion in review space; OAuth edit opt-in.
Web: unit test for the scope warning helper. E2E: an agent edits a page over MCP; the owner sees the applied
change in page history and accepts the removal suggestion naming the agent.
