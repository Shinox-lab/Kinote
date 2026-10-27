# Routing engine: documents get their own page

Addendum to `docs/superpowers/specs/2026-10-26-routing-engine-design.md`. Everything there stands unless this changes it.

## Why

The owner captured a meeting note ("Oct 14 meeting with Ryko", 19 facts). Their wiki keeps one page per meeting:
**Client - George** has the child pages **Meeting 1** and **29Sep**. The engine instead split the note into facts and
filed each one on its own: 12 inserts on 29Sep and 6 on Client - George. No page was created. The owner expected a new
meeting page next to the others.

There are three causes, all in the design rather than the model:

1. **Facts are planned one at a time.** Nothing looks at the capture as a whole, so "this is a meeting note" is never
   decided. Creating pages per fact would have made 19 pages.
2. **The planner cannot see how a space is organised.** It gets the candidate pages' text, not their place in the page
   tree. It cannot see that meetings are sibling pages under the client page, or how they are titled.
3. **R9 ("update before inventing") leans every fact towards an existing page.** Creating needs 0.85 confidence and
   editing needs 0.6. A page about the same client always fits well enough.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **While splitting, the engine also decides the capture's shape: a `document` or `updates`.** A document stands on its own: meeting notes, minutes, a report, a call summary. It usually has a subject, a date, headings or a list structure. Updates are statements about things already in the wiki ("George's video cost is RM200"). Both shapes are split into facts. A document *also* gets its own page. Updates follow the existing flow unchanged. | Owner's expectation. The shape belongs to the whole capture, not to any one fact. |
| D2 | **A document becomes one new page holding the capture as written.** The engine does not rewrite it. It may add a title, and it keeps the Markdown structure. Every block cites the capture (R12). | The note is the record of the meeting; rewriting it loses what was said. |
| D3 | **The new page goes where pages like it already live.** The engine finds the best parent from candidates and their page tree, and titles the page to match its siblings' pattern (for example "14Oct" next to "29Sep"). | Owner: "the pages are all using one date meeting per page already." |
| D4 | **A document also updates the pages that hold standing facts (owner's decision).** After the page is created, the note is split into facts as today. A fact that changes or adds to what another page states is planned against that page: for example "main launch expected end of December" goes to Client - George. Facts that only matter inside the meeting stay on the new page alone. The new page itself is never a candidate for these edits. | Owner chose "update both sides". The client page stays current; the same fact living in two places is accepted for now. |
| D5 | **Linking the two sides is Phase A's job.** Once `[[` links and backlinks exist, each standing edit links to its meeting page, and the meeting page shows what it updated. This addendum only records the capture citation, as today. | Owner: "this can be resolved in Phase A using comments, links and backlinks." |
| D6 | **R9 changes for documents.** For a document, the engine is not asking whether a page is worth creating; it is only choosing where the page goes. Placement uses the edit threshold (0.6) and the margin rule (0.1). If no parent is clearly ahead, the whole document goes to Needs a home as one item and a person picks the parent. Below 0.6 confidence that the capture is a document, it is treated as updates. R9 is unchanged for updates. | A wrong guess is cheap to fix (Undo archives the page); a scattered note is not. |
| D7 | **The planner sees the page tree around its candidates.** For each candidate page: its path of ancestors, and up to 10 sibling and child titles, newest first. This applies to both shapes. | An update can also need "the child page for this month", not just a block. |
| D8 | **Each fact carries its subject.** The split prompt tells the model to put the note's subject into every statement, for example the client from a heading such as "meeting with Ryko". "The gap between About Us and brand DNA should be smaller" becomes "On the RYKO website, …". | Without it, facts from one note lose their client and match on meaning alone. |
| D9 | **Undo all reverses both sides.** It archives the created page and undoes the standing edits, as created pages and edits are undone today. "Wrong page → move to…" on a created document moves the page under the chosen parent and saves a routing example (R11). | Same safety as today; corrections teach placement. |
| D10 | **The receipt leads with the new page,** "New page: 14Oct under Client - George", then "Also updated" with the standing edits grouped by page as today. | The owner should see at a glance that the note was filed as one page. |
| D11 | **The evaluation set gains documents.** At least three labelled document captures (a meeting note, minutes, a call summary) are added, each with the expected parent and the expected standing edits. A short update must still be routed as updates. The same 90% bar applies, and "document filed under the expected parent" counts as one placement. | Prompts and thresholds are tuned on this set; without labelled documents a change could break them silently. |

## Flow

1. **Shape, in the split call.** The existing split call also returns the shape:
   `{ shape, confidence, subject, title, facts }`. This adds no model call; the split prompt gains a few lines. A
   capture over 3,000 characters is split in parts, and the first part's answer decides the shape (my call). Shape is
   not a fork between two kinds of processing. **Every capture is split into facts.** The shape only decides whether
   the whole note *also* gets its own page. When the shape is unclear (confidence under 0.6), no page is created and the
   facts are routed as updates, which is today's behaviour.
   The sender can override the shape in the Capture box: **Auto** (default), **New page** or **Updates only** (my
   call). Corrections teach the auto choice through document examples (D9).
2. **Document path.**
   1. Gather parent candidates for the whole note: the three existing signals (passages, cards and the graph on the
      subject's names), embedding the note's first part.
   2. Plan the placement: the model sees the candidates with their page trees (D7) and returns
      `create_page(space, parent, title)` with a confidence.
   3. Check: an editable space, the threshold and margin (D6), and no other page with the same title under that parent.
      If the title is taken, it gets a suffix such as "14Oct (2)".
   4. Create the page with the capture's Markdown.
   5. Take the facts from step 1 (D8) and plan each one with the new page excluded from the candidates (D4). The model may answer
      "no standing change" for a fact; that fact is recorded as filed on the new page.
3. **Updates path.** As today, with page trees in the planner's input (D7) and the subject carried into facts (D8).

## Edge cases (builder check, my calls)

- **No parent clearly ahead (D6).** The document waits in Needs a home as one item, showing the proposed title and the
  top parent candidates. The standing facts wait with it and are not planned yet, so they can never target a page that
  does not exist. When a person picks a parent (any page, or the top level of a space) and may edit the title, the page
  is created and the standing facts are routed as in step 2.5. This is a new capture-level item next to the existing
  fact items.
- **Unsure standing facts.** In the document path, a standing fact below the threshold, tied between two pages, or
  needing a "which George?" answer is recorded as filed on the new page. It is never sent to Needs a home and never
  asks a question. The meeting page already holds it, so nothing is lost, and a 19-fact note does not flood the list.
  Standing facts may insert, replace, propose a removal (a suggestion, R2) or be already known. They may not create
  pages.
- **Scope and edit rights.** A page scope makes that page the parent. A space scope limits parent candidates to that
  space. A parent is chosen only among pages in spaces the sender can edit. If the best match sits in a space the sender
  can only read, the document goes to Needs a home with that reason; R16 suggestions cannot create pages.
- **Corrections for documents (D9).** Routing examples gain a kind, `fact` or `document`. A document example stores
  the subject and title with the chosen parent, and only the placement step (2.2) sees it. The fact planner keeps
  seeing fact examples only.
- **Per-page Undo on the new page** archives that page only. The standing edits stay, each with its own Undo on its
  own page. Undo all reverses everything (D9).
- **"Filed on the new page" outcome.** A fact with no standing change, or an unsure one, gets the outcome
  `filed_in_document` and points at the new page. It has no change row, because the page's blocks all cite the capture
  already. The receipt counts these under the new page. The evaluation scores a document by its parent, title pattern
  and expected standing edits, not by these facts.

## Not in scope

- Links, backlinks and comments between the meeting page and the pages it updated (Phase A).
- Editing or merging a later capture into an existing meeting page ("add to the 14Oct notes"). Updates may still insert
  into it like any page.
- Templates for meeting pages.

## Left to the builder

- Prompt wording.
- How the page-tree context is formatted for the model.

## Status of related fixes (already made, not committed)

- `docker-compose.yml` now passes `ROUTER_*` to the services. The worker refuses the deterministic router when
  embeddings or Ask use a real model.
- The planner accepts the flat edit shape models answer with, and asks again when it can read no edit at all.
- `ROUTER_REASONING=off` asks a reasoning model to answer directly. An answer cut off at the token limit now fails with
  that reason, without a second paid attempt.
- Still open from the main spec: "token use per tenant is recorded" is not implemented. `chatJson` ignores the usage the
  provider returns.
