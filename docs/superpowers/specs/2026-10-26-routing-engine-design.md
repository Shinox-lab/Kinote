# Routing engine and Capture page — design

Date: 2026-10-26. Status: draft for the owner's review.
Builds on: `2026-10-18-kinote-standalone-design.md` (the main design). Where this spec and the main design differ,
this spec wins; the main design's "Revisions" section lists what changed. The agent sections of the main design (MCP
tiers, Curator) are being reworked separately for external agents. Capture over MCP belongs to that rework (owner's
call); this spec keeps the data model ready for agent senders but builds no MCP endpoint.

## Intent

The selling point of kinote is that information finds its own place. A person (or an external agent) drops in
anything — a sentence, a pasted email, meeting notes — and the wiki adds, updates or removes the right sections on the
right pages, across spaces, with every change cited, visible and undoable. People stay at the centre: they see every
change, keep the final say on anything destructive, and correct the engine when it is wrong, which teaches it.

Success, as one story: Desmond types into Capture: "Billing moved from Stripe to Adyen on 3 Nov. Aisha owns it now. We no
longer offer on-site support." The engine asks "Which Aisha — Aisha Rahman (Finance) or Aisha Lim (Engineering)?"; he
answers. Within a minute the receipt says: *Billing service* updated (provider and owner replaced) and *Decision log*
row added, both in Engineering (review off) and already searchable; the removal of the on-site support sentence in
*Support policy* (Clients, review on) waits for a reviewer.
Ask now answers "who owns billing?" with "Aisha Rahman [Billing service (v9, …)]". Once the MCP rework lands, an external agent's
capture gets the same treatment.

Scale to design for (per tenant): more than 500 pages and files, around 200 WhatsApp messages and up to 50 Drive changes
per 5-minute sync once those connectors exist (they come later; see "Order of work"), plus captures from people and
agents.

## Goals

- A **Capture page** in the sidebar: a box that accepts any text, a thread for the engine's follow-up questions, and a
  history of receipts.
- A **routing engine** that splits a capture into facts, finds where each belongs, and edits live pages: insert,
  replace, create a page, or propose a removal.
- **Retrieval built for placement at scale:** the existing hybrid passage search, plus new **page cards** and a new
  **entity graph**, all in Postgres.
- **Review follows the space** for routed and agent edits; **removals with nothing replacing them always wait for a
  person**.
- **Receipts** with per-page outcome, the reason each page was chosen, Undo, Undo all, and "Wrong page → move to…".
  Clicking a page opens it with this capture's changes highlighted.
- **Review bundles:** the review queue groups a capture's waiting pages together.
- A **routing evaluation set** that guards placement quality.

## Non-goals

- A chat panel or chatbot beyond the Capture thread. The thread carries the engine's questions and the sender's answers;
  a docked chat on every page is a later option.
- AI writing help inside the editor (owner's call: not the selling product).
- WhatsApp and Google Drive feeding the engine: a later slice, after Phase A and Phase C. This spec only keeps the door
  open (the engine takes any text plus a source reference).
- Editing files. Files are read-only sources the engine can cite, never targets.
- Anything MCP: no endpoint, no agent-token sign-in, no capture tools (owner's call: the MCP rework owns them, including
  capture over MCP). This spec only sets the shared rules (R1, R2, R4) the rework follows and keeps `captures` ready for
  an agent sender.
- A separate graph database or Postgres graph extension (see R6).
- Templates, public pages, import (owner's call: out).

## Anti-goals (failure even if it technically works)

- **A fact on the wrong page.** Owner's first fear. Every design choice below prefers "ask a person" over a guess.
- **A fact deleted that should stay.** Owner's second fear. The engine never deletes text on its own authority.
- A change nobody can see or reverse. Every engine change has a receipt, a reason, a citation and an Undo.
- Agents trampling people: a block a person edited recently is never replaced by the engine (rule 5 of the main design).

## Decisions

| # | Decision | Why |
|---|---|---|
| R1 | **Review follows the space for every agent edit, including the routing engine.** In a space with review off, routed edits apply live and index at once; with review on, the page's snapshot waits for a reviewer. This replaces the main design's "an agent's change always needs a person's approval" (S3, review rule 2). | Owner's answer. Routing is the product; making every routed edit wait would bury reviewers and defeat "auto-adding". |
| R2 | **Removals with nothing replacing them are never applied by the engine.** They become *suggestions* that a person accepts or declines, in every space. Replacing a fact with a newer one is an edit, not a removal, and follows R1. | Owner's fear of wrong deletes; owner agreed "removals always wait" feels right. |
| R3 | **The engine never removes text because a source stopped mentioning it.** Absence is not evidence. Source deletes keep flagging pages as the main design says. | Same fear; matches "text is never deleted automatically". |
| R4 | **A block that cites a still-valid source version (a file or page version) is never replaced or removed by the engine.** The change becomes a suggestion with a conflict warning. Blocks cited only by earlier captures *can* be replaced: a newer capture updating an older one is the normal update path. *(Builder check, my call.)* | Two sources disagree; a person decides. Treating capture citations as blocking would freeze every routed fact. |
| R5 | **Retrieval for placement uses three signals, fused:** passage search (exists), page cards (new) and the entity graph (new). | Search answers "where is this already written?"; placement also needs "which page should hold this new fact?" and "what else depends on this?". |
| R6 | **The entity graph is plain Postgres tables** with a recursive query capped at two hops. No Apache AGE or Neo4j. Revisit if routing needs three or more hops, whole-wiki community summaries, a tenant passes about 10M edges, or the evaluation set shows misses only graph queries fix. | At this scale (estimated 2k–20k entities, 20k–300k mentions and edges per tenant) a two-hop lookup on indexed tables takes milliseconds. AGE would bypass the RLS guarantee, cannot load in PGlite tests, is unknown to Drizzle, and needs a custom Postgres image. The tables are graph-shaped, so they can be copied into a graph engine later. |
| R7 | **Cards and the graph are derived from indexed versions only**, like chunks. They carry `space_id`, follow moves in the same transaction, and leave with a withdrawal in the same transaction. | Rules 1, 4, 9 and 12 of the main design. An entity is discoverable only through mentions in spaces the actor can read. |
| R8 | **The engine is a built-in agent per tenant ("Routing engine") that acts on behalf of the sender.** Every change records both. It can only read spaces the sender can read and only edit spaces the sender can edit. | People stay accountable; the engine cannot widen anyone's access. |
| R9 | **Update before inventing.** If a fact is already written somewhere, the engine edits it there; it creates a new home only when nothing similar exists, and creating a page needs a higher confidence than editing one. | Most wrong-page mistakes come from inventing a new home. |
| R10 | **Low confidence goes to "Needs a home".** When the best target is below the threshold, or not clearly ahead of the next one, the fact waits for a person to place it. | Owner's first fear. |
| R11 | **Corrections teach.** "Wrong page → move to…" and placements from Needs a home are saved as routing examples per space; the planner sees the most similar recent examples. | The engine improves on the tenant's own judgement without fine-tuning. |
| R12 | **Captures are the source of what they add.** Every engine edit cites the capture (and the fact) it came from; captures themselves are never indexed. | "Why does this page say that?" always has an answer; raw captures would duplicate the wiki in search. |
| R13 | **One routing job at a time per tenant.** | Two captures touching the same page cannot plan against stale content. At the target volume (hundreds a day) a per-tenant queue keeps up. |
| R14 | **The engine uses the existing OpenAI-compatible chat provider** (separate model setting allowed), with structured JSON output validated by Zod and one retry. A deterministic fake router serves tests and local e2e. | Same provider pattern as Ask (P2–P4 of the embeddings spec); no network in unit tests. |
| R15 | **Version citations are not written by this spec.** It creates the `citations` table for both kinds and writes capture citations; version citations (and their `source_changed` / `source_removed` flagging) are written by later work (the MCP rework and the connectors). R4 applies as soon as they exist. *(Builder check, my call.)* | Keeps this spec focused; the table shape is settled once. |
| R16 | **If the best home is in a space the sender can read but not edit, the change becomes a suggestion for that space's editors** (a proposed insert or replace), never a duplicate page in a writable space. Candidate search therefore covers the sender's *readable* spaces; edits apply only where the sender can edit. *(Builder check, my call.)* | Prevents the owner's first fear: a fact landing on a second, wrong page because the right one was out of reach. |
| R17 | **The engine ignores the Inbox.** Inbox documents are never candidates or targets, and get no page card, entity mentions or edges. *(Builder check, my call.)* | Inbox items are private to their uploader; skipping them avoids leaks through cards or the graph without a per-owner column. |

## How a capture is routed

```
 Capture page ──────▶ captures (row) ──▶ job capture.route (one at a time per tenant)
   1 split into facts            (model)
   2 resolve entities            (alias, trigram, embedding; ask the sender when ambiguous)
   3 gather candidate pages      passage search ┐
                                 page cards     ├─ fused ─▶ top pages (readable by the sender)
                                 entity graph   ┘
   4 plan edits                  (model sees live blocks of candidates + routing examples)
   5 check the plan              (block ids, access, protection, citations, duplicates, confidence)
   6 apply                       one direct-session transaction per page, then a snapshot per page
   7 receipt                     per page: applied / waiting for review / suggestion / needs a home
```

1. **Split.** The model turns the capture into facts: a statement, a kind (`new`, `change`, `removal`), the names it
   mentions, any date, and scope hints ("for Project Atlas"). Instructions in the capture text are data, not commands
   (rule 13 of the main design); the engine has no tool that changes access, status or settings.
2. **Resolve entities.** Each name is matched to entities through exact alias, trigram similarity and name embedding,
   within entities discoverable from the sender's readable spaces. When two or more entities fit closely, the engine
   asks the sender in the Capture thread ("Which Aisha?"). Only the facts that depend on the answer wait; the other facts
   carry on and apply. When the answer arrives, the waiting facts are routed in a new job (still one at a time per
   tenant) and the receipt grows. An unanswered question after 7 days sends the waiting facts to Needs a home. *(Builder
   check, my call.)*
3. **Gather candidates.** For each fact: passage search with the fact text (pages only, sender's readable spaces outside
   the Inbox; see R16, R17), page
   card vector search, and graph lookups (pages mentioning the resolved entities, plus pages one hop away through their
   edges). The three lists are merged by reciprocal rank fusion; the top 8 pages go forward (a setting). A scope given by
   the sender (from the box's "limit to" control, or by capturing from inside a space or page) restricts all three.
4. **Plan.** The model receives the fact, each candidate's title, card and live outline, the live blocks most relevant
   to the fact (with block ids, read from the Yjs state), and up to 5 similar routing examples. It returns operations —
   `insert_after(block)`, `replace(block, markdown)`, `create_page(space, parent, title, markdown)`, `remove(block)` —
   each with a confidence, a one-line reason ("this page already states the payment provider"), and the fact it serves.
   It may also return "already known" (the page already says this) for no edit.
5. **Check.** The server validates every operation; the model's output is a proposal, never trusted:
   - the page exists and is live; block ids exist in the live document; a change on a page the sender can read but not
     edit becomes a suggestion (R16);
   - `remove` becomes a removal suggestion (R2);
   - `replace` or `remove` on a block a person changed within the space's `human_protection_seconds`, or on a block
     citing a still-valid source version, becomes a suggestion with the reason (R4, rule 5);
   - an operation matching an open suggestion or a change already waiting in review is dropped as a duplicate;
   - confidence below the threshold, or a top target not clearly ahead of the second, sends the fact to Needs a home
     (R10); `create_page` needs the higher threshold (R9). Thresholds are settings tuned on the evaluation set.
6. **Apply.** Per page, all operations of the capture go in one Yjs transaction through the existing direct session
   (`openDirectSession`), with origin source `agent`, the Routing engine as actor, and the capture id. Each changed
   block's before and after Markdown is recorded. A snapshot is taken right after (new version reason `capture`); the
   space decides between `indexing` and `pending_review` (R1). Each new or replaced block gets a citation to the capture.
7. **Receipt.** The capture's status and per-page outcomes are shown on the Capture page.

The engine reads live content for planning but finds candidates through the index. A page that has never been indexed
(new, waiting in a review space) is invisible to candidate search; this is accepted.

## Page cards

One card per page document, rebuilt when a page version is indexed (job `version.card`):

- **summary**: two to four sentences from the model on what the page covers and what belongs on it;
- **outline**: the heading path list of the indexed version;
- **embedding** of `title + summary + outline`, same model and dimensions as chunks (2560 `halfvec`).

Files get no card: they are never edit targets.

## Entity graph

Built from indexed versions (job `version.entities`, after indexing), per chunk:

- The model extracts entities (`person`, `team`, `system`, `organisation`, `project`, `place`, `other`) and typed
  relationships between them (`owns`, `uses`, `part_of`, `depends_on`, `member_of`, `related_to`), each tied to the
  chunk and its block ids.
- Extraction results are cached by chunk `content_hash` (like `embedding_cache`): an unchanged chunk is never extracted
  twice.
- **Entity resolution:** a new name joins an existing entity when an alias matches exactly, or when trigram and
  embedding similarity are both high and the model confirms; otherwise a new entity is created. A `person` entity may
  link to a tenant member (`user_id`) when the name or email matches one member unambiguously.
- Indexing a new version replaces that document's mentions and edges in the same transaction as its chunks; a
  withdrawal deletes them; a move updates their `space_id`. An entity with no mentions left is deleted.
- Documents in the Inbox are skipped (R17).
- Graph lookups always filter mentions and edges by the actor's readable spaces before following them.
- The nightly index check (main design, "Index drift") also checks that every indexed page has a card and that every
  mention and edge belongs to an indexed version.

## Suggestions

A suggestion is a proposed change the engine was not allowed to apply: a removal (R2), a replace or removal blocked by
protection or a conflicting citation (R4), or any change on a page the sender cannot edit (R16).

- It is attached to a block and shown in the page as a margin marker, on the receipt, and in the review bundle.
- **Who decides:** in a space with review off, any editor of the space; with review on, a reviewer (not the sender,
  unless the space has `allow_self_approval`).
- **Accepting** applies the change as an engine edit "on behalf of {sender}, accepted by {person}" and takes a snapshot.
  In a review space the acceptance counts as approval of that snapshot when the page has nothing else waiting; otherwise
  the change joins the page's waiting snapshot.
- **Declining** keeps the text and records who declined.
- A suggestion whose block has since been changed or deleted becomes `stale` and is closed.

## What people see

### Capture page

A sidebar entry **Capture**, under Home (mockup accepted by the owner, option A):

- A box that accepts any text (up to 20,000 characters), with a **limit to** control (Anywhere, or a space, or a page)
  and **Send**. Opening Capture from inside a space or page presets the limit to that space or page.
- Below it, the sender's captures, newest first. Each shows the original text, the thread (engine questions and the
  sender's answers, answered inline), and the receipt.
- **Needs a home**: facts the engine would not place. The sender, or any editor of a candidate space, picks a page (or
  a new page) or dismisses the fact. Placing runs the planner restricted to that page.

### Receipt

Grouped by space and page, each marked **Applied**, **Waiting for review**, **Suggestion** or **Already known**:

- before and after of each changed block, and the reason the page was chosen;
- **Undo** per page and **Undo all applied**: each changed block whose content still equals the engine's result is
  restored to its before state as a new edit (rule 6: history is never rewritten); blocks changed since are listed as
  "changed since, not undone"; inserted blocks are removed and created pages archived;
- **Wrong page → move to…** on inserted blocks: removes them from this page, plans an insertion restricted to the chosen
  page, applies it, and saves a routing example (R11). For a replaced block, "wrong page" undoes the replacement and
  re-plans on the chosen page.
- A page in a space the viewer cannot read appears only as "1 change in a space you can't see".

**Clicking a page card opens the full page** with this capture's blocks highlighted in the Routing engine's colour and
labelled "on behalf of {sender}", scrolled to the first change. Because a routed edit in a review-off space is indexed
at once, the existing "changes since the indexed version" highlight would be empty; the page opens in a "changes from
this capture" mode that compares the page before and after the capture, reusing the existing compare and
`ChangesList`/`ReviewDocument` styling. A "Waiting for review" card opens the bundle in Reviews.

### Review bundle

The review queue groups waiting snapshots and suggestions that came from the same capture, per space the reviewer can
review:

- header: "Routing engine on behalf of {sender} · from Capture · {time}", the capture excerpt that
  produced the changes, and titles of pages already applied elsewhere (readable ones only);
- each page uses the existing full-document diff view; removal suggestions appear inline with **Approve removal** /
  **Decline** and any conflict warning ("cited by Enterprise MSA 2025.pdf (v3), still valid");
- pages are approved or rejected one by one, or all at once. Approval stays per page snapshot, as today.

## Ready for the MCP rework

The MCP rework will add capture tools (submit, read the receipt, answer a question) on top of this spec. To keep that
small: `captures.sender_type` already allows `agent` and `channel` allows `mcp`; the engine resolves the sender's access
through the same grant check for users and agents (R8); and receipts never assume the sender is a person. Agent edits
made directly by the rework's tools follow R1, R2 and R4.

## Data model

All tables follow the main design's conventions: `tenant_id`, RLS policy, Drizzle-generated migrations.

**`captures`** — `id`, `tenant_id`, `sender_type` (`user` | `agent`), `sender_id`, `channel` (`console` | `mcp`), `text`,
`source_ref`, `scope_space_id`, `scope_page_id`, `status` (`queued` | `routing` | `waiting_for_answer` (some facts wait on the sender) | `done` |
`failed`), `error`, `created_at`, `finished_at`.

**`capture_messages`** — `id`, `tenant_id`, `capture_id`, `author` (`engine` | `sender`), `body`, `options` (jsonb, the
choices offered), `created_at`.

**`capture_facts`** — `id`, `tenant_id`, `capture_id`, `ordinal`, `statement`, `kind` (`new` | `change` | `removal`),
`outcome` (`applied` | `waiting_review` | `suggested` | `needs_home` | `already_known` | `dismissed` | `undone`),
`confidence`, `reason`, `placed_by` (null, or the person who placed it from Needs a home).

**`capture_changes`** — `id`, `tenant_id`, `capture_id`, `fact_id`, `document_id`, `space_id`, `block_id`, `op`
(`insert` | `replace` | `create_page`), `before_markdown`, `after_markdown`, `version_id` (the snapshot it landed in),
`status` (`applied` | `undone` | `moved`), `created_at`.

**`suggestions`** — `id`, `tenant_id`, `document_id`, `space_id`, `block_id`, `kind` (`remove` | `replace` | `insert`),
`proposed_markdown`, `reason`, `blocked_by` (`removal` | `protection` | `conflict` | `no_edit_access`), `conflict_citation_id`,
`capture_id`, `fact_id`, `status` (`open` | `accepted` | `declined` | `stale`), `resolved_by`, `resolved_at`.

**`citations`** — as the main design, with the source widened: `source_kind` (`version` | `capture`),
`source_document_id` and `source_version_id` (for `version`), `capture_id` and `fact_id` (for `capture`). State
`source_changed` / `source_removed` applies to `version` sources only.

**`routing_examples`** — `id`, `tenant_id`, `space_id`, `statement`, `statement_embedding`, `chosen_document_id`,
`wrong_document_id` (nullable), `created_by`, `created_at`.

**`page_cards`** — `document_id` (primary key), `tenant_id`, `space_id`, `version_id`, `summary`, `outline` (text[]),
`embedding` (`halfvec(2560)`), `updated_at`. HNSW index on `embedding`.

**`entities`** — `id`, `tenant_id`, `kind`, `name`, `aliases` (text[]), `name_embedding` (`halfvec(2560)`), `user_id`
(nullable), `created_at`. Trigram index on `name` and aliases.

**`entity_mentions`** — `tenant_id`, `entity_id`, `document_id`, `version_id`, `chunk_id`, `space_id`, `block_ids`
(text[]). Btree on `(tenant_id, entity_id)` and `(tenant_id, document_id)`.

**`entity_edges`** — `id`, `tenant_id`, `from_entity_id`, `to_entity_id`, `type`, `document_id`, `version_id`,
`chunk_id`, `space_id`. Btree on `(tenant_id, from_entity_id)` and `(tenant_id, to_entity_id)`.

**`entity_extraction_cache`** — `tenant_id`, `model`, `content_hash`, `result` (jsonb).

Changed: `versions.reason` gains `capture`; `agents.kind` gains `router` (one built-in row per tenant, created with the
tenant); the snapshot's review decision becomes `space.review_required` only (R1), and `pages.agent_changed_at` stops
gating review (it may stay for display).

## API

| Route | Who |
|---|---|
| `POST /captures` (text, scope) | any member with editor on at least one space |
| `GET /captures` (mine), `GET /captures/:id` | the sender; tenant admins |
| `POST /captures/:id/answer` | the sender |
| `POST /captures/:id/undo`, `POST /capture-changes/:id/undo` | the sender, or an editor of the page's space |
| `POST /capture-changes/:id/move` (target page) | an editor of both spaces |
| `GET /needs-home`, `POST /capture-facts/:id/place`, `POST /capture-facts/:id/dismiss` | the sender, or an editor of the target space |
| `GET /pages/:id/suggestions`, `POST /suggestions/:id/accept`, `POST /suggestions/:id/decline` | see "Suggestions" |
| `GET /reviews` | gains grouping by capture |
| `GET /pages/:id/capture-changes?capture=…` | readers of the page (powers "changes from this capture") |

New error codes: `capture_too_long` (400), `capture_not_found` (404), `capture_not_waiting` (409, answering a capture
that asked nothing), `change_already_undone` (409), `suggestion_not_open` (409), `router_unavailable` (503, the job
retries; the capture shows "routing delayed").

Audit events: `capture.created`, `capture.routed`, `capture.question_asked`, `capture.answered`, `capture.change_undone`,
`capture.change_moved`, `capture.fact_placed`, `suggestion.accepted`, `suggestion.declined`.

## Evaluation

A routing fixture: a seeded corpus (pages across several spaces, with known entities) and labelled captures, each with
the expected target pages and operations. Metrics:

- **placement hit rate**: facts landing on an expected page (target: at least 90% of placed facts; facts sent to Needs a
  home do not count as misses but are reported);
- **wrong removals**: must be zero (R2 makes this structural; the check guards regressions);
- **duplicates**: facts producing a change already present.

A script runs it against the configured model; a change to prompts, thresholds or models must not lower the hit rate or
raise wrong removals. It joins the CI evaluation gate in the hardening slice. Unit and e2e tests use the deterministic
fake router.

## Costs at the target scale

Model calls, not the graph, are the cost to watch: page cards (once per indexed page version), entity extraction (once
per changed chunk, cached by hash), and per capture one split call plus one plan call per group of facts. Token use per
tenant is recorded so quotas can use it in the hardening slice. Batching per WhatsApp chat and merging repeated Drive
saves are designed with those connectors.

## Order of work

1. **This spec:** routing engine, Capture page, suggestions, receipts, review bundles, page cards, entity graph,
   evaluation set. (The MCP rework, including capture over MCP, is planned separately.)
2. **Phase A:** `[[` picker and backlinks, comments and mentions, notifications, side-peek, slash menu extras. (Comments
   later let the engine ask questions on a page; notifications tell reviewers a bundle waits.)
3. **Phase C:** page collections (typed fields on child pages; table, board and calendar views) and Excalidraw drawings
   (versioned, co-edited, text indexed, shapes linking to pages). Both become places the engine can write to.
4. **WhatsApp and Google Drive** feeding the engine.

Each gets its own spec when its turn comes.

## Left to the builder

- Prompt wording, the fusion weights, candidate count, thresholds and margins (tuned on the evaluation set).
- How the planner presents live blocks to the model (Markdown with block id markers is the expected shape).
- The exact UI of the margin marker for suggestions and of the Needs a home list, within the existing console style.
- Whether entity extraction runs per chunk or per document batch, as long as results are cached by content hash.
- Plan split: the builder may split this spec into several implementation plans (for example retrieval layer, engine
  and apply, console).
