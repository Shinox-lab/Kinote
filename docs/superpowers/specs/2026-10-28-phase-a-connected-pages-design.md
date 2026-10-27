# Phase A: connected pages — design

Status: draft, 2026-10-28. Follows the routing engine (3a–3d, merged). Builds on
`docs/2026-10-18-living-wiki-standalone-design.md` ("Collaboration features", `links`) and the routing specs
(`2026-10-26-routing-engine-design.md`, `2026-10-27-routing-documents-design.md`). Where they differ, this wins for
Phase A.

## Why

The routing engine puts facts on the right pages, but the pages don't know about each other. A meeting note becomes its
own page under `Client - George`, and its facts update `Client - George` too. Today nothing ties those two together, so
a reader of either can't see the other. The owner wants both sides connected through links, backlinks and comments
(decided 2026-10-27). People also need to talk about a block (comments), point someone at it (mentions), and hear about
it (notifications) without leaving the page they are on (side-peek). On 2026-10-28 the owner added file captures: a
capture can carry a PDF, Office file or image, and it is routed like typed text.

## Goals

1. **Page links:** typing `[[` (or `@`) opens a picker of pages, and the link shows the target's current title.
2. **Backlinks:** each page lists the pages that link to it, plus the captures that edited it from a document page.
3. **Routing both sides:** a document page shows which standing pages its facts updated. Each standing block that the
   engine changed from a document shows where it came from.
4. **Block comments** with replies and resolve, including `@` mentions of people in comments and in pages.
5. **In-app notifications:** mentions, comments on your threads, review requests and outcomes, and captures waiting on
   you.
6. **Side-peek:** a linked page opens in a panel beside the current page, with a way to open it full size.
7. **Slash extras:** Link to page, New sub-page, Mention a person, Callout.
8. **File captures:** attach one file to a capture. Its text is read by the existing extractor and routed, and the
   original file stays attached to the page the capture created.

## Non-goals

- Email notifications (a later slice, per the standalone design), and push or WhatsApp delivery.
- Unlinked mentions ("pages that name this page but don't link it").
- A graph view of links.
- Audio and video captures (speech to text), and describing photos that have no text. These wait for WhatsApp/Drive.
- Facts from a file citing that file through `citations` and flags. Provenance goes through the document page instead.
- Anything the owner has dropped: AI writing help, templates, public pages, import, mobile.

## Anti-goals

- A link or comment that lets someone see a page they can't read. Titles, excerpts, backlinks, peeks and notifications
  are all filtered by read access when they are read, not when they are written.
- The engine adding visible text to pages just to cross-link them. Both-sides links are derived from records the engine
  already keeps (`capture_changes`), so Undo removes them with no extra cleanup.
- Notification noise. The same mention is never notified twice, and you never get a notification for your own action.

## Decisions

Calls marked *(my call)* were made by me while writing this design; the owner can overturn them.

**D1. Page links are inline content, not text.** A link is a BlockNote custom inline node `pageLink {documentId}` that
renders the target's live title, so it follows renames. Snapshot indexing (`packages/core/src/snapshot.ts`) fills
`links` from these nodes (kind `link`), and still reads the old `[[uuid]]` text form. An archived or unreadable target
shows as "Page unavailable" with no title. *(my call: unreadable and archived look the same, so nothing leaks)*

**D2. The `[[` picker** searches page titles in spaces the reader can see, by trigram similarity (`pg_trgm` is installed; a trigram index on document titles is new), best match
first, with recent pages when the query is empty. It also offers "New page '…'" under the current page. `@` opens one
picker listing people first, then pages. *(my call)*

**D3. Backlinks** appear in a "Linked from" section at the end of each page, collapsed when empty. Each entry shows the
source page title, the space, and the text of the linking block (up to 160 characters). They are read from `links`
joined with read access, and use the reviewed snapshot like search does. *(my call: links in waiting snapshots don't
show until approved, consistent with search)*

**D4. Routing both sides is derived from `capture_changes`** joined with `captures.document_page_id`:
- On the document page, an "Updated from this page" section lists each standing page and how many sections changed,
  linking to the highlight view built in 3c.
- On a standing page, each block the engine changed from a document carries a small "From: <document title>" chip
  that opens the document page in side-peek.
- The same pairs show in "Linked from" as "Updated by".

When a change is undone it drops out; nothing is written into page text. *(my call: derived, so Undo needs no
cleanup)*

**D5. Comments use BlockNote's comments extension with our own `ThreadStore`** backed by the API. They are not stored in
the Y.Doc: we need access checks, a unique `@` parse, and notifications.
- New tables `comment_threads` (`id`, `tenant_id`, `document_id`, `block_id` (nullable), `resolved_by`, `resolved_at`,
  `created_by`, `created_at`) and `comments` (`id`, `thread_id`, `tenant_id`, `body` jsonb, `author_id`, `created_at`,
  `edited_at`, `deleted_at`). Both are under RLS like the other tenant tables.
- The comment mark in the document carries only the thread id.

**D6. Who may comment:** anyone with edit rights in the space. Viewers see comments but can't add them, because adding
a thread writes a mark into the document. *(my call: viewer comments can come later as page-level threads)*

**D7. Mentions** are an inline node `mention {userId}` in pages and comments. A new table `user_mentions` (`tenant_id`,
`user_id`, `document_id`, `block_id`, `comment_id` nullable, `first_seen_at`) is rebuilt per snapshot and per comment.
- A notification fires only when a (user, block) or (user, comment) pair is new.
- Mentioning someone who can't read the space still records the mention, but sends no notification. The picker greys
  out such people with "No access to this space". *(my call)*

**D8. Notifications** use a new table `notifications` (`id`, `tenant_id`, `recipient_id`, `kind`, `actor_type`,
`actor_id`, `document_id`, `block_id`, `thread_id`, `capture_id`, `created_at`, `read_at`). Kinds:
- `mention`
- `comment_reply` (a thread you started or replied to)
- `review_requested` (to reviewers of the space)
- `review_approved` and `review_rejected` (to contributors)
- `capture_waiting` (to the sender, when the engine asks a question or something needs a home)

Rules:
- A bell in the top bar shows the unread count, with a panel of the newest 50 and "Mark all read".
- Updates come from polling every 30 s and on window focus (the existing react-query pattern); there are no sockets.
- Your own actions never notify you.
- Read access is checked when the list is read, and items you can no longer see are hidden.

**D9. Side-peek:**
- Clicking a page link, backlink, "From:" chip, notification or search result opens the page in a right panel (about
  45% wide on desktop, a full sheet on narrow screens), editable if you may edit it.
- "Open as full page" and Escape close it. Cmd/Ctrl-click or middle-click opens the full page directly.
- Only one peek is open at a time, and a link clicked inside the peek replaces it.
- The URL gains `?peek=<documentId>` so the view can be shared and Back works.

**D10. Slash extras:**
- **Link to page** opens the `[[` picker.
- **New sub-page** creates a child page titled "Untitled" and inserts a link to it.
- **Mention a person** opens the `@` picker.
- **Callout** is a new custom block with an emoji and a tint.

Divider, toggle, quote and code already exist in BlockNote 0.49 and stay as they are.

**D11. File captures:**
- **The capture box gains Attach** (and drop). One file per capture, within the existing upload size limit, and of a
  type the extractor reads: PDF, DOCX, PPTX, XLSX, PNG, JPEG, WEBP or GIF. Audio and video are refused with "Audio and
  video can't be read yet".
- **The file is stored like an upload**, under a hidden placement until routing ends. A `capture.extract` job reads it
  through the existing extractor, then queues `capture.route`. The routed text is the typed text (if any) followed by
  the extracted text.
- **A file capture is a document unless "Updates only" is chosen.** It still gets the 3d treatment (its own page, facts
  update standing pages), and the page title comes from the typed text or the file name. *(my call)*
- **When the page is created**, the file becomes a child file document of that page, visible in the tree and search like
  any file. With "Updates only" the file goes to the sender's Inbox. If the document needs a home, the file waits with
  it and moves when it is placed.
- **Limits:**
  - Extracted text over 50,000 characters is not routed. The capture fails with "Too long to route — the file was kept
    in your Inbox", and the file is filed in the Inbox. *(my call: bounds cost; ties into the later cost plan)*
  - A file with no readable text fails with "No text could be read from this file", and the file is kept in the Inbox.
- **Undo** of the document page archives the page as in 3d. The file moves to the Inbox rather than being archived.
  *(my call: never lose the original)*
- The capture card shows the file name and type, plus "Reading the file…" while extraction runs.

## Delivery

Phase A comes as three plans, each mergeable on its own:

| Plan | Delivers |
|---|---|
| A1 Links | D1–D4, D9, and the "Link to page" and "New sub-page" slash items |
| A2 Talk | D5–D8, "Mention a person", and the notifications from reviews and captures |
| A3 Files | D11 and Callout |

## Edge cases

- **A link to a page in another tenant** (pasted id): it is dropped at indexing and renders "Page unavailable".
- **Moving the target page to another space** keeps the link. Readers who lose access see "Page unavailable".
- **Deleting a block with an open thread** keeps the thread under "Comments on removed text" in the page's comments
  panel, read-only. *(my call)*
- **Restoring an old version** rebuilds `links` and `user_mentions` from it. It doesn't re-notify mentions that were
  seen before.
- **Engine edits to a block that has comments** keep the comment mark when the block is replaced. If the engine removes
  the block, the thread becomes "on removed text".
- **Merge or duplicate detection between pages** is out of scope. Links only connect pages.
- **A file capture while the extractor is down** waits and retries like uploads do (`extractor_unavailable`). The card
  says "Waiting for the file reader".

## Left to the builder

- Exact picker ranking weights, panel widths, chip styling and the callout palette, all within the existing design
  tokens.
- Whether `user_mentions` and `links` rebuilds share one pass over the blocks.
- Pagination of backlinks over 50 entries.
- Notification retention (keep 90 days is a fine default).
