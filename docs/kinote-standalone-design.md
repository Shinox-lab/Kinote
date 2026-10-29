# Kinote (standalone product) — design

Date: 2026-10-18. Status: draft for the owner's review.
Builds on: `2026-10-15-kinote-core-design.md` (W1–W8), `2026-10-15-wiki-console-mvp-design.md` (M1–M5), the
extraction doc "Kinote: extracted requirements, architecture and standalone scope", and the owner's answers to its
seven open decisions (2026-10-18).

This is a new product built from zero. Nothing is imported from the Shinox codebase; its rules and tested patterns are
carried over where this spec says so (references like "from W1"). Where this spec and the Shinox specs differ, this spec
wins. Implementation plans are written per slice (see "Delivery slices") after this spec is approved.

## Revisions

**2026-10-26: routing engine** (`superpowers/specs/2026-10-26-routing-engine-design.md`). That spec wins where the two
differ:
- **Routing is the headline feature:** a Capture page feeds a routing engine that edits the right pages, backed by page
  cards and an entity graph in Postgres. Capture over MCP comes with the MCP rework.
- **S3 and review rule 2 are replaced.** Review follows the space for every agent edit, including the engine. Removals
  with nothing replacing them never apply on their own; they become suggestions a person accepts. A block citing another
  still-valid source is never replaced or removed by the engine.
- **The agent sections (MCP tiers, Curator) are being reworked for external agents** and will get their own spec.
- **New order after slice 2:** routing engine, then Phase A (links and backlinks, comments, mentions, notifications,
  side-peek), then Phase C (page collections and Excalidraw drawings), then WhatsApp and Google Drive. The "Delivery
  slices" table below is kept for history.

## Progress

The one place for where the build stands. Update it whenever a part is merged or the next step changes. "Merged" means
merged into local `main`; nothing has been pushed. Since 2026-10-30, work goes straight onto `main`, not onto phase branches.

| Part | State | Spec · plan |
|---|---|---|
| Slices 0–1: foundations, live pages | Merged | this spec · `plans/2026-10-18-slice-0-1-remediation.md` |
| Slice 2: files, sources, console | Merged | `specs/2026-10-20-slice-2-*`, `specs/2026-10-20-slice-2b-*` · `plans/2026-10-20-slice-2*` |
| Console redesign; embeddings and Ask | Merged | `specs/2026-10-24-console-redesign-design.md`, `specs/2026-10-25-openai-compatible-embeddings-and-ask-design.md` |
| Routing engine 3a–3c: placement, engine, console | Merged | `specs/2026-10-26-routing-engine-design.md` · `plans/2026-10-26-routing-3*` |
| Routing 3d: documents get their own page | Merged | `specs/2026-10-27-routing-documents-design.md` · `plans/2026-10-27-routing-3d-documents.md` |
| Phase A: links, talk, file captures (A1–A3) | Merged 2026-10-28 | `specs/2026-10-28-phase-a-connected-pages-design.md` |
| XLSX preview and GridCraft spreadsheet editor | Merged 2026-10-29/30 | `specs/2026-10-29-extend-xlsx-preview-design.md`, `specs/2026-10-29-gridcraft-xlsx-editor-design.md` |
| Phase C1a: collection fields | Merged 2026-10-29 | `specs/2026-10-29-phase-c-collections-design.md` · `plans/2026-10-29-phase-c1a-fields.md` |
| Phase C1b: collection views (table, board, calendar, timeline) | Merged 2026-10-30, with polish fixes (`4da272a`) | same spec · `plans/2026-10-29-phase-c1b-views.md` |
| Phase C1c: the engine writes fields; Ask reads collections | Merged 2026-10-30 | same spec · `plans/2026-10-30-phase-c1c-engine-fields-and-ask.md` |
| Phase C2: Excalidraw drawings | Merged 2026-10-30 | `specs/2026-10-30-phase-c-drawings-design.md` · `plans/2026-10-30-phase-c2-drawings.md` |
| **Agents and MCP rework for external agents** | **Next**; needs its own spec | — |
| WhatsApp, then Google Drive | Not started | slices 4–5 below |

Spec and plan paths are under `docs/superpowers/`.

Known gaps:
- The small issues deferred from the C1a review are still open.
- C1c and C2: `pnpm test:pg` and the live checks (`live-checks/2026-10-phase-c1c-live-check.md`,
  `live-checks/2026-10-phase-c2-drawings-live-check.md`) have not been run; the only Postgres running was the owner's
  own stack. C2's browser tests (`e2e/drawings.spec.ts`) pass on the local PGlite stack.
- C2: a drawing block pasted into another page arrives empty (same-page copies get their own scene); a full-screen
  drawing whose block someone deletes just closes, with no "This drawing was removed" message.
- The Postgres test suite (`pgtest.sh`) has not been run for Phase C, because Docker was down. The PGlite unit and
  end-to-end suites pass.

## Intent

A multi-tenant SaaS wiki where people and AI agents write the same pages together, live. Every source a team has (files
uploaded in the wiki or sent straight to the engine, Google Drive, WhatsApp) lands in the same wiki. A search index built
into the product serves people and agents. Nothing enters the index without passing its space's rules: an agent's change
always waits for a person's approval; a person's change waits only where the space has review switched on. A page always
says whether its latest change is indexed. When a source changes or disappears, the index follows, and every page that
relied on it is flagged.

Success, as one story: a tenant admin signs up, creates a space with review on and invites a colleague. Both edit a page
at the same time while an agent edits it through MCP. The page shows "Saved · not indexed (awaiting approval)". The
reviewer approves; search and Ask cite the new version. A PDF uploaded into the space becomes searchable. A WhatsApp
group mapped to the space produces a daily transcript; a message deleted for everyone in WhatsApp disappears from the
transcript and from the index. A Drive file deleted at the source is withdrawn, and the page that cited it shows "Source
removed".

Users:

| Who | What they do |
|---|---|
| Tenant owner | Everything an admin does, plus billing and deleting the tenant. |
| Tenant admin | Manages members, groups, agents, spaces, sources; sees every space. |
| Member | Reads and edits the spaces their grants allow. |
| Space reviewer | Approves or rejects snapshots in that space. |
| Viewer | Reads only. |
| Agent | A service identity in one tenant (the built-in Curator or an external agent through MCP). Same grants as people; cannot approve. |

## Glossary

- **Tenant**: one customer organisation. Every row belongs to exactly one tenant.
- **Space**: an area of pages and files with one access list and one review setting.
- **Document**: anything in the registry: a **page** (written in the editor) or a **file** (uploaded or synced).
- **Live content**: a page's current Yjs document, saved continuously.
- **Version**: a numbered, immutable copy of a document. For a page it is a **snapshot** of the live content; for a file,
  one upload or one revision from a source.
- **Indexed version**: the one version per document that search and Ask can see.
- **Source**: a connected system (upload API, Google Drive, WhatsApp) and its settings.
- **Citation**: a provenance link from a page block to a source document version.
- **Flag**: a marker on a page or block that needs a person's attention (source changed, source removed, conflict).

## Decisions

| # | Decision | Why |
|---|---|---|
| S1 | **Multi-tenant SaaS.** `tenant_id` on every row, Postgres row-level security on every table, a per-tenant prefix in object storage. | Owner's answer 2. RLS is a second guard behind the query filter (the Shinox build had the filter only). |
| S2 | **Live co-editing.** Pages are Yjs documents served by Hocuspocus and edited in BlockNote. Versions are snapshots of the live content. | Owner's answer 1. Replaces the draft-and-submit model and its `draft_changed` conflict (W6). |
| S3 | **The index holds only approved snapshots.** An agent's change always needs a person's approval. A person's change needs approval only in a space with review on. Every page shows whether its latest change is indexed. | Owner's answers 3 and 4. Keeps "nothing reaches readers unapproved" while letting agents write directly. |
| S4 | **Access by role and group per space; review is a per-space option** with named reviewers. No built-in audiences. | Owner's answer 3. Replaces customer/internal (W5). |
| S5 | **One registry.** Every page and file is a document with numbered versions and one status; every change goes through one submit path. Files are moved, never copied. | From W1: one approval state, one index path. |
| S6 | **The index lives in Postgres:** pgvector (HNSW on `halfvec`), full-text search and an optional reranker, with the access filter inside the query. Only chunks of indexed versions exist. | No external engine to keep in step; a withdrawal is a row delete in the same transaction. |
| S7 | **Embeddings and language models go through provider interfaces.** Start with an API embedding provider. Model and dimensions are deployment settings; changing them re-embeds in the background. | Owner's answer 6. |
| S8 | **Self-hosted in our cloud as containers:** web, api, collab, worker, extractor, whatsapp, Postgres, S3-compatible object storage. | Owner's answer 6. |
| S9 | **Postgres is the source of truth. Markdown is a one-way export** (a space as a zip of Markdown plus original files), with an optional read-only Git mirror later. No two-way file sync. | Owner's answer 5: the wiki already holds XLSX, PPTX and other files, so Markdown files cannot be the master. Live Yjs state and access rules also do not survive a file round trip. |
| S10 | **Every source follows one lifecycle:** list changes, fetch, detect deletes, scheduled reconcile. Connectors in v1: upload (console, API, MCP), WhatsApp through Baileys, Google Drive. | Owner's answer 7, and the original requirement that changes and deletes are handled, not only creates. |
| S11 | **Citations tie page blocks to source versions.** A source change flags dependent blocks "Source changed"; a delete flags "Source removed". | The gap found in the Shinox design: it tracked document changes but not the pages built from them. |
| S12 | **Agents are tenant principals.** They write through the API or MCP as Yjs transactions marked as agent changes. A block a person edited recently is protected from agent replace or delete. | Lets agents publish directly (answer 4) without trampling people's work (idea from Civigent). |
| S13 | **Text extraction is part of ingest** (Docling in a Python worker). Images, Office files, sheets and scans become searchable; the extracted text is what reviewers see. | The Shinox build kept these types unsearchable (W2, "stored"). |
| S14 | **Inbox instead of Unsorted.** Each tenant has a system space "Inbox". Files without a target land there. It is the one space with per-item visibility: tenant admins see everything, others see only what they uploaded (the search query applies the same rule). | Every searchable chunk then has a space and so an access list, with a single, written exception. |
| S15 | **The Curator is a built-in agent** that ingests sources into pages, lints the wiki and saves answers as pages, under the same rules as any agent. | The "living" part, designed in from the start instead of deferred. |
| S16 | **Baileys is an unofficial WhatsApp client.** Dedicated number, opt-in per chat, risk stated in the console. The connector interface allows WhatsApp's official Cloud API to replace it. | Owner's answer 7. A ban or a protocol change must not break the rest of the product. |
| S17 | **Stack:** TypeScript pnpm monorepo, Fastify, Drizzle, Zod contracts, React 19, TanStack Router and Query, Tailwind 4, Vitest, Playwright (as in the Shinox build), plus Hocuspocus 4, Yjs, BlockNote core, pgvector, a Postgres-backed job queue, and Docling. | Known stack; every addition is open source with a permissive or MPL licence. |

## Rules the system must keep

Carried from the Shinox build and adapted. Every plan's review checks these.

1. **The wiki owns the content; the index is derived** and can be rebuilt from versions at any time (from W1).
2. **One place for bytes and approval state:** the registry (from W1).
3. **Nothing enters the index without passing its space's rules.** Agent changes always need a person's approval (S3).
4. **Access belongs to the space.** A document's chunks carry its space; moving a document changes who can find it at once
   (S4).
5. **A person's decision outranks automation.** A document a person moved is never moved back by a sync (from W7). A block a
   person edited recently is never replaced by an agent (S12).
6. **Nothing typed is lost.** Live content is saved continuously; restoring a version is a new edit, never a rewrite of
   history.
7. **Citations show only indexed facts:** title, version number and date of the version found (from W8).
8. **The title is part of the indexed text,** so a rename is a content change (from W8).
9. **Removing is fast, adding is gated.** Withdraw, archive and source deletes need no approval and leave the index in the
   same transaction.
10. **Markdown is the reviewed and indexed form of a page.** Blocks and Yjs state are stored for the editor; the server
    converts them with BlockNote's server utilities and indexes the Markdown.
11. **File content never runs.** SVG and HTML uploads are refused; Markdown goes through a parser; viewers render from
    bytes and fall back to a download link (from M1).
12. **Permissions are applied inside the search query,** before ranking. A model's score can rank or drop a passage, never
    grant access.
13. **Retrieved text is data, not instructions.** Agents and Ask treat passages as quotes; no passage can change a
    permission, a status or a setting.
14. **Every actor is audited:** people, agents and connectors each have an identity on every change.

## Architecture

```
 Browser (React + BlockNote) ──HTTP──▶ api (Fastify) ──▶ Postgres (+ pgvector, RLS)
        │                                │   ▲                ▲
        └──WebSocket──▶ collab (Hocuspocus, Yjs) ─────────────┤
                                         │                    │
 External agents ──MCP (HTTP)──▶ api ────┘                    │
                                                              │
 worker (job queue in Postgres): snapshot, extract, chunk, embed, index, reconcile, curator, export
        │                │
        │                └──▶ extractor (Python, Docling)
        └──▶ object storage (S3-compatible, per-tenant prefix)

 whatsapp (Baileys, one socket per linked number) ──▶ api / Postgres
 Embedding and LLM providers (API) ◀── worker, api
```

| Service | Responsibility |
|---|---|
| web | Static React app: wiki, review queue, sources, admin. |
| api | REST under `/api/v1`, MCP under `/mcp`, auth, permissions, file upload and download. |
| collab | Hocuspocus 4 with a Postgres store; authenticates each connection and checks the space grant; records who changed each block (from the transaction origin); schedules snapshots. |
| worker | Runs jobs from the Postgres queue. Every job is idempotent and keyed (blueprint 12.3). Failed jobs go to a dead-letter list shown to admins. |
| extractor | Python service wrapping Docling: file bytes in, structured text (sections, tables, page numbers) out. No network access besides the worker. |
| whatsapp | One Baileys socket per linked number; writes messages and media to the registry; reports health. |
| Postgres | 17 with pgvector 0.8 or later (0.8 added iterative index scans, which keep filtered vector queries from returning too few rows). |
| Object storage | Original bytes, extracted text, exports. Keys start with the tenant id. |

Hocuspocus 4 needs Node 22 or later and gives every transaction a structured origin with a `source` field; collab uses it
to tell human, agent and restore changes apart. Server-side edits (agents, restores) go through Hocuspocus's direct
connection; the plan confirms its v4 API (`openDirectConnection`).

## Data model

Every table except `users` has `tenant_id uuid not null references tenants(id)` and an RLS policy
`tenant_id = current_setting('app.tenant_id')::uuid`. The api and worker connect with a role that does not bypass RLS
and set `app.tenant_id` at the start of every transaction. Migrations run with a separate role. Ids are UUIDs.

### Tenancy and access

**`tenants`** — `id`, `name`, `slug` (unique), `plan`, `created_at`, `deleted_at`.

**`users`** — `id`, `email` (unique), `name`, `phone_e164` (verified, nullable; used by the WhatsApp direct-upload
channel), `created_at`. Global; reached only through `memberships`.

**`memberships`** — `tenant_id`, `user_id`, `role` (`owner` | `admin` | `member` | `viewer`), `created_at`. Unique
`(tenant_id, user_id)`.

**`agents`** — `id`, `tenant_id`, `name`, `kind` (`curator` | `external`), `created_by`, `created_at`, `disabled_at`.

**`agent_tokens`** — `id`, `tenant_id`, `agent_id`, `token_hash`, `scopes` (`read` | `write` | `upload`, array),
`expires_at`, `last_used_at`, `revoked_at`.

**`groups`** — `id`, `tenant_id`, `name` (unique per tenant). **`group_members`** — `tenant_id`, `group_id`,
`principal_type` (`user` | `agent`), `principal_id`.

**`spaces`** — `id`, `tenant_id`, `name` (unique per tenant), `slug`, `kind` (`normal` | `inbox`), `review_required`
(bool), `quiet_seconds` (default 120: idle time before an automatic snapshot), `human_protection_seconds` (default 300),
`allow_self_approval` (bool, default false), `created_by`, `created_at`, `archived_at`.

**`space_grants`** — `tenant_id`, `space_id`, `principal_type` (`user` | `agent` | `group`), `principal_id`, `role`
(`viewer` | `editor` | `reviewer` | `admin`). A space role includes the ones before it. Tenant admins and owners act as
space admins everywhere. An agent can hold `viewer` or `editor`, never `reviewer` or `admin`.

### Registry

**`documents`** — `id`, `tenant_id`, `space_id` (never null; Inbox when no target), `parent_id` (a page document in the
same space, or null), `position` (fractional index for ordering siblings), `kind` (`page` | `file`), `title`,
`source_id` (null for pages and console uploads), `external_id`, `placement` (`pinned` | `synced`), `latest_version_id`,
`indexed_version_id`, `source_deleted_at`, `archived_at`, `created_by_type`, `created_by`, `created_at`.
Unique `(tenant_id, source_id, external_id)` where `source_id` is not null.

**`pages`** — `document_id` (primary key), `tenant_id`, `slug` (unique per space), `ydoc_state` (bytea, the live
content), `live_updated_at`, `live_changed_since_snapshot` (bool), `agent_changed_at` (last agent change not yet in an
indexed version; null when none).

**`versions`** — `id`, `tenant_id`, `document_id`, `number` (1, 2, … per document), `title`, `status`, `content_hash`
(sha-256 of the indexed text: `# {title}\n\n{markdown}` for pages, the bytes for files), `reason` (`quiet` | `submit` |
`agent` | `restore` | `upload` | `source` | `transcript`), `created_by_type` (`user` | `agent` | `connector`),
`created_by`, `created_at`, `reviewed_by`, `reviewed_at`, `review_note`, `indexed_at`, `error`.
Page columns: `markdown`, `blocks` (jsonb), `ydoc_snapshot` (bytea). File columns: `object_key`, `file_name`,
`mime_type`, `size_bytes`, `source_revision`, `extracted_key` (object key of the extracted text).

Version statuses:

| Status | Meaning |
|---|---|
| `extracting` | A file version waiting for the extractor. |
| `pending_review` | Waiting for a reviewer. |
| `indexing` | Being chunked and embedded. |
| `indexed` | The document's searchable version (at most one per document). |
| `superseded` | Replaced by a newer indexed version, or a newer snapshot replaced it while it waited. |
| `rejected` | A reviewer rejected it (reason kept). |
| `withdrawn` | Taken out by a person, an archive or a source delete. |
| `failed` | Extraction or indexing failed; retryable. |
| `stored` | Kept and viewable, but no text could be extracted (for example audio or video in v1). Never reviewed. |

**`version_contributors`** — `tenant_id`, `version_id`, `principal_type`, `principal_id`. Who changed the page between
the previous version and this one; the review screen shows them and marks agent contributors.

**`block_activity`** — `tenant_id`, `page_id`, `block_id`, `actor_type`, `actor_id`, `changed_at`. Last change per block,
written by collab from each transaction's origin. Drives agent protection (S12) and authorship colours.

### Index

**`chunks`** — `id`, `tenant_id`, `space_id` (copied from the document; updated in place on a move), `document_id`,
`version_id`, `ordinal`, `heading_path` (text[]), `block_ids` (text[], pages only), `page_from`, `page_to` (files with
pages), `text`, `token_count`, `content_hash`, `tsv` (generated `tsvector`), `embedding` (`halfvec(D)`, D from
deployment settings), `embedding_model`.
Indexes: HNSW on `embedding` with cosine distance, GIN on `tsv`, btree on `(tenant_id, space_id)`.
Only chunks of indexed versions exist: indexing a new version inserts its chunks and deletes the old version's chunks in
one transaction.

**`embedding_cache`** — `tenant_id`, `model`, `content_hash`, `embedding`. A chunk whose text did not change between
versions reuses its embedding instead of calling the provider again.

### Provenance, links and flags

**`citations`** — `id`, `tenant_id`, `page_id`, `block_id`, `source_document_id`, `source_version_id`, `chunk_id`
(nullable), `quote` (up to 500 characters), `state` (`ok` | `source_changed` | `source_removed`), `created_by_type`,
`created_by`, `created_at`.

**`links`** — `tenant_id`, `from_page_id`, `from_block_id`, `to_document_id`, `kind` (`link` | `mention` | `embed`).
Rebuilt from each snapshot; backlinks read it the other way round.

**`flags`** — `id`, `tenant_id`, `document_id`, `block_id` (nullable), `kind` (`source_changed` | `source_removed` |
`conflict` | `stale` | `orphan` | `broken_link`), `detail` (jsonb), `created_by_type`, `created_by`, `created_at`,
`resolved_by`, `resolved_at`.

### Sources

**`sources`** — `id`, `tenant_id`, `kind` (`upload_api` | `whatsapp` | `drive`), `name`, `config` (jsonb, no secrets),
`target_space_id`, `trusted` (bool, default false; see "Review rules"), `cursor` (jsonb), `last_sync_at`,
`last_reconcile_at`, `status` (`active` | `paused` | `error` | `unlinked`), `error`, `created_by`, `created_at`.

**`source_mappings`** — `tenant_id`, `source_id`, `external_container` (a Drive folder id or a WhatsApp chat id),
`space_id`, `created_at`. A source can map several containers, each to a space.

**`source_items`** — `tenant_id`, `source_id`, `external_id`, `document_id`, `external_revision`, `content_hash`,
`last_seen_at`, `deleted_at`.

**`secrets`** — `id`, `tenant_id`, `owner_type`, `owner_id`, `ciphertext`, `key_id`. Envelope-encrypted (Drive tokens,
the Baileys auth state). Never returned by any route.

**`whatsapp_chats`** — `tenant_id`, `source_id`, `chat_jid`, `name`, `is_group`, `mapped` (bool).

**`whatsapp_messages`** — `tenant_id`, `source_id`, `chat_jid`, `message_id`, `sender_jid`, `sender_name`, `sent_at`,
`kind` (`text` | `image` | `document` | `audio` | `video` | `other`), `text`, `media_document_id`, `edited_at`,
`revoked_at`. Stored only for mapped chats.

### Collaboration and operations

**`comment_threads`**, **`comments`** — threads anchored to a block of a page (BlockNote comments, whose core is liberally
licensed), with `resolved_at`. Agents may comment.

**`notifications`** — `tenant_id`, `user_id`, `kind`, `subject`, `read_at`, `created_at`.

**`audit_events`** — `id`, `tenant_id`, `type` (dotted), `actor_type`, `actor_id`, `subject_type`, `subject_id`,
`payload`, `created_at`.

**`tenant_usage`** — `tenant_id`, `period`, `embedding_tokens`, `llm_tokens`, `storage_bytes`, `documents`. Feeds quotas.

Migrations are generated by Drizzle, one per task that changes the schema, never hand-edited. RLS policies live in a
generated-then-reviewed SQL migration per table.

## Pages: live editing, snapshots and status

### Saving
Collab stores the Yjs state in `pages.ydoc_state` on every change (debounced by Hocuspocus's store hook). Nothing a person
or agent types is lost, whether or not it is ever indexed. The title lives in the Yjs document beside the blocks, so a
rename is co-edited like text. The slug is set when the page is created and changed only through "Rename" (admin of the
space), which is checked against `slug_taken`.

### Snapshots
A snapshot turns the live content into a version. It is taken:
- automatically after `quiet_seconds` with no change (default 120);
- when someone clicks **Index now** (no-review space) or **Submit for review** (review space);
- at the end of every agent write call, so a reviewer sees an agent's change as one unit;
- when a version is restored (reason `restore`).

To take one, the worker reads the Yjs state, converts it with `@blocknote/server-util` (`yDocToBlocks`, then
`blocksToMarkdownLossy`), and hashes `# {title}\n\n{markdown}`. If the hash equals the latest version's, no version is
written (`no_changes` when a person asked). An empty body after trimming is refused with `empty_file` when a person asked
and skipped when automatic.

If a version of the page is already waiting (`pending_review`), the new snapshot replaces it: the waiting one becomes
`superseded`. A reviewer always reviews the newest state.

### Review rules
A snapshot needs review when **either** of these is true:
1. the space has `review_required`;
2. an agent changed the page since its indexed version (`pages.agent_changed_at` is set).

Otherwise it goes straight to `indexing`. A file version follows rule 1, plus "uploaded by an agent". A connector's
version follows rule 1 unless the source is `trusted` (set by a tenant admin, shown on the source). Agent-authored
content is never auto-approved, whatever the source setting.

Approving indexes that snapshot. `agent_changed_at` is cleared only when no agent change happened after the approved
snapshot was taken. Rejecting needs a reason (1–300 characters); the live content is not touched, and the page offers
**Restore indexed version** (writes the indexed snapshot back into the Yjs document as a new change). The author of a
snapshot cannot approve it unless the space has `allow_self_approval`; agent contributions always need someone else.

While a newer version waits, the indexed version stays searchable (from the Shinox core spec).

### What the page shows
The header badge, always visible to editors and viewers:

| Badge | When |
|---|---|
| Indexed · v7 | Live content equals the indexed version. |
| Saved · indexing soon | Live content changed; no review needed; waiting for the quiet period. |
| Saved · not indexed (awaiting approval) | A snapshot waits for a reviewer. Shows who changed what, agents marked. |
| Saved · changed since v8, awaiting approval | The live content moved on after the waiting snapshot was taken. |
| Indexing… | The worker is chunking and embedding. |
| Not indexed · v8 rejected | The latest snapshot was rejected; the indexed version (if any) stays live. |
| Index failed | With **Retry** for editors. |
| Withdrawn | The page is out of the index; editing and submitting again goes through review in a review space. |

A **Changes** panel shows a block diff between the indexed version and the live content, coloured by author (person or
agent), from `block_activity`.

### Lifecycle
- **Create** in a space, optionally under a parent page.
- **Move** within or across spaces (editor in both). A cycle is refused (`parent_cycle`, from W8). Moving across spaces
  changes `chunks.space_id` in the same transaction. Moving into a review space returns the indexed version to
  `pending_review` (its chunks leave the index) unless the mover is a reviewer of the target space.
- **Archive** (space admin) is refused while child documents exist (`has_children`, from W8). It withdraws the page.
  **Restore** brings it back withdrawn.
- **Withdraw** (space admin or reviewer) takes the page out of the index without archiving it.
- **History** lists versions with status, contributors and reviewer; any two can be compared; any can be restored as a
  new change.

## Files

- **Upload** in the console, through the API, through MCP, or through WhatsApp's direct channel. A target space is required;
  without one the file lands in Inbox. Limit 50 MB per file by default, set per plan.
- **Allowed types:** PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG, JPEG, WebP, GIF, and audio and video for storage only. SVG
  and HTML are refused (from W2: they can carry script).
- **Ingest:** a new version starts `extracting`. The extractor returns structured text: sections, tables kept whole,
  page numbers, OCR for images and scans. Then the review rules decide between `pending_review` and `indexing`. Types with
  no extractable text become `stored`.
- **Same bytes again** (same hash, same space, not withdrawn, not source-deleted) is `unchanged`: no version, no
  extraction (from the Shinox registry).
- **A newer version** stays out of the index until it is indexed; then the older one becomes `superseded`.
- **Placement:** a person's move pins the file (`placement = pinned`); a sync never moves a pinned file (from W7).
  Synced files cannot be edited or replaced by hand (`managed_by_source`, from the Shinox core spec).
- **Viewers** (from M1): Markdown, text and CSV, image, PDF (pdf.js 4.2.67 or later with `isEvalSupported: false`), XLSX
  (sheet preview), DOCX (sanitised HTML), PPTX (extracted text per slide), and a download fallback. Every viewer loads
  lazily and falls back to download if it throws.
- **Chunk inspector** (idea from RAGFlow): for any version, editors see the extracted text and the chunks as indexed.

## Index and retrieval

- **Chunking.** Pages split at headings and never inside a block; files split along the extractor's sections, with tables
  whole. Each chunk's indexed text starts with the document title and heading path. Target sizes are settings, tuned by
  the evaluation set; the plan sets starting values.
- **Embedding.** Batched through the embedding provider. A chunk whose `content_hash` is in `embedding_cache` reuses it.
  Dimensions must be 4,000 or fewer to allow an HNSW index on `halfvec`.
- **Search** (`search(actor, query, filters)`):
  1. resolve the actor's readable spaces (direct grants, groups, tenant role);
  2. vector search with `space_id = any(...)` and pgvector's iterative index scans on;
  3. full-text search (`websearch_to_tsquery`, `simple` configuration so any language works without stemming);
  4. merge with reciprocal rank fusion;
  5. rerank through the reranker provider when one is configured;
  6. return passages with `citeAs` = `{version title} (v{n}, updated {date})` and a link to the block or PDF page.
- **Ask.** A language-model answer built only from the passages search returned, with citations; it says so when nothing
  relevant is found. **Save as page** turns an answer into a new page authored by the Ask assistant (an agent), so it waits
  for approval like any agent change (idea from nashsu/llm_wiki).
- **Evaluation.** Each tenant can keep a labelled question set; the platform keeps one per fixture corpus. A change to
  chunking, embedding model or prompts must not lower recall@10 on the platform set (blueprint 11.6).
- **Quotas.** Embedding and model tokens are counted per tenant (`tenant_usage`); over quota answers 429
  `quota_exceeded` and ingest pauses with a visible status, never silently.

## Change and delete handling

| Case | Behaviour |
|---|---|
| Same content | No version, no re-index (hash compare for files, pages, transcripts). |
| Changed content | New version, same review rules; the indexed version stays until the new one is indexed. |
| Source item deleted | Version withdrawn and chunks deleted in one transaction; `source_deleted_at` set. A synced document shows "Removed at source" until an editor dismisses it; a pinned one stays withdrawn. |
| Source item moved between mapped containers | A synced document follows the new mapping's space; a pinned one stays (from W7). |
| Mapping removed | Its synced documents are withdrawn and marked removed at source. |
| WhatsApp message edited | Message row updated; the day's transcript gets a new version. |
| WhatsApp message deleted for everyone | Message row marked revoked and its text dropped; its media document withdrawn; the transcript gets a new version without it. |
| Cited source changed | Every citation of the old version becomes `source_changed`; the page and the blocks get a flag; the Curator proposes an update (agent change, so it waits for approval). |
| Cited source removed | Citations become `source_removed`; the page and blocks get a flag. Text is never deleted automatically. |
| Lost webhooks or events | Each source runs a reconcile (default daily): list everything remote, compare with `source_items`, run the change or delete path for differences (blueprint 12.3). |
| Index drift | A nightly index check: every indexed version has chunks with embeddings for the current model; no chunk belongs to a version that is not indexed. Differences are repaired and counted in the admin health view. |
| Purge | A tenant admin can purge a document: bytes, versions, chunks and citations are hard-deleted, the audit event stays. Needed for data-protection requests. |

## Connectors

```ts
interface Connector {
  kind: 'upload_api' | 'whatsapp' | 'drive';
  /** Changes since the cursor: created, updated or deleted items, plus the next cursor. */
  listChanges(ctx: ConnectorContext, cursor: unknown): AsyncIterable<SourceChange>;
  /** Every item currently present, for reconcile. */
  listAll(ctx: ConnectorContext): AsyncIterable<SourceItemRef>;
  /** Bytes, MIME type, title and revision of one item. */
  fetch(ctx: ConnectorContext, ref: SourceItemRef): Promise<FetchedItem>;
}
```

All three feed `submitVersion` with `created_by_type = 'connector'` and record `source_items`.

### Upload API
A tenant admin creates an `upload_api` source with a target space; it issues a token with the `upload` scope. Each upload
is a file version; uploading with the same `external_id` replaces the document; `DELETE` by `external_id` runs the
delete path. This is the "upload straight to the engine" path: the file appears in the wiki like any other.

### WhatsApp (Baileys)
- **Link.** A tenant admin scans a QR code in the console. The Baileys auth state is kept in `secrets` through a custom
  store (not the library's file store). One linked number per source; the console recommends a dedicated number and states
  that the connection is unofficial and can be blocked by WhatsApp.
- **Chats.** The source lists chats and groups; an admin maps chosen ones to spaces. Messages of unmapped chats are not
  stored.
- **Transcripts.** One Markdown document per mapped chat per day (`WhatsApp · {chat} · {date}`): time, sender name, text,
  and links to media documents. It is rebuilt as messages arrive and snapshotted at most every 15 minutes and at the end of
  the day, so a busy group does not re-index on every message.
- **Media.** Images, documents, audio and video become file documents under that day's transcript; audio and video are
  `stored` in v1 (no transcription yet).
- **Edits and deletes.** Message edits and "delete for everyone" update the message row and produce a new transcript
  version (table above). The plan confirms the Baileys event names for both against the pinned version.
- **Direct channel.** A tenant member whose verified phone number is on their profile can message the linked number
  one-to-one; text becomes a page and files become uploads in Inbox, authored by that member.
- **History.** On first link, history is backfilled for a set number of days (default 7, at most 90) where the client
  provides it.
- **Operations.** One socket per linked number in the whatsapp service; reconnect with backoff; health and last message
  time on the source page; unlinking deletes the auth state.
- **Package.** Baileys (WhiskeySockets, MIT). As of October 2026 it ships 7.0.0 release candidates; pin an exact version
  and wrap it behind the connector so the official Cloud API can replace it.

### Google Drive
OAuth per tenant; each mapping is a folder and a space. Changes come from the Drive changes feed with a page token;
reconcile lists the mapped folders. Google Docs export as DOCX and Sheets as XLSX, then go through extraction like any
upload. Subfolders are flattened into the mapping's space in v1.

## Agents and MCP

- **Identity.** An agent is created by a tenant admin, gets tokens with scopes, and is granted spaces directly or through
  groups. It can hold `viewer` or `editor`.
- **MCP.** Streamable HTTP at `/mcp`, authenticated by bearer token (OAuth for third-party clients in a later slice).
  Tools come in two tiers (idea from Civigent):

| Tier | Tools |
|---|---|
| Read | `list_spaces`, `get_tree`, `search`, `ask`, `read_page` (indexed version by default; `live: true` returns live content and its badge), `read_file` (extracted text), `get_backlinks`, `get_flags`, `get_page_status` |
| Write | `create_page`, `edit_page` (block operations), `append_to_page` (Markdown), `upload_file`, `move_document`, `add_comment`, `cite_source` |

  No tool approves, purges, changes access or links sources: those stay with people.
- **Block operations.** `edit_page` takes operations by block id: insert after, replace, delete, set title. The api
  converts Markdown to blocks with `tryParseMarkdownToBlocks` and applies all operations of one call as one Yjs
  transaction with an agent origin. Editors see the change live, labelled with the agent's name. The call ends with a
  snapshot (reason `agent`), which waits for approval.
- **Protection.** Replacing or deleting a block that a person changed within the space's `human_protection_seconds`
  answers 409 `block_recently_edited`; the agent can comment instead. Inserting near it is allowed.
- **Citations.** `cite_source` (and the Curator) link a block to a source version and chunk; the review screen shows each
  cited passage beside the block.
- **Audit.** Every tool call writes an audit event with the agent, the tool, a hash of the arguments and the outcome.

### Curator (built-in agent)
Runs inside the worker with its own agent identity, per tenant, with a monthly token budget. Can be turned off per tenant or
space.
- **Ingest** (from the LLM-wiki pattern): when a source version is indexed, it reads it, plans which pages to create or
  update (a source summary page plus affected topic pages), then writes them through the same block operations with
  citations. Every result waits for approval. Two passes, analyse then write (idea from nashsu/llm_wiki).
- **Follow-up on flags:** for `source_changed` it proposes an update; for `source_removed` it comments with what is no
  longer supported.
- **Lint** (weekly): orphan pages, broken links, citations to withdrawn versions, and passages that contradict each other
  become flags.

## Collaboration features

- Live cursors and presence; authorship colours from `block_activity`.
- Comments on blocks, with resolve; mentions notify.
- Review queue per tenant and per space: waiting snapshots with diff, contributors and cited passages; approve or reject.
- Notifications in the app (email in a later slice): review requested, approved, rejected, flag raised, mention.
- Links between pages (`[[` picker) and backlinks.
- Version history, compare and restore.

## Export

A space admin can export a space: a zip with one Markdown file per page (YAML front matter: `id`, `title`, `version`,
`status`, `sources`), the folder structure of the tree, the original files, and a `manifest.json`. Indexed versions by
default; live content on request. A scheduled one-way push to a Git repository is a later slice. Importing a Markdown
folder or an Obsidian vault is out of scope for v1.

## API

REST under `/api/v1`, JSON, every reply parsed by a Zod schema from the shared contracts package (from the Shinox console
plan). Collab at `/collab` (WebSocket). MCP at `/mcp`. The console uses the same REST routes.

| Area | Routes (abridged) | Who |
|---|---|---|
| Auth and tenants | sign-up, sign-in, invitations, `GET /me`, switch tenant | everyone |
| Members, groups, agents | CRUD, agent tokens | tenant admin |
| Spaces | `GET/POST /spaces`, `PATCH /spaces/:id` (review settings), grants | read: grant; write: space admin |
| Tree | `GET /spaces/:id/tree`, `GET /spaces/:id/archived` | viewer |
| Pages | `POST /pages`, `GET /pages/:id` (badge, versions), `POST /pages/:id/snapshot` (Index now or Submit), `POST /pages/:id/move`, `/archive`, `/restore`, `/withdraw`, `POST /pages/:id/versions/:n/restore` | editor; archive and withdraw: space admin |
| Files | `POST /files` (upload), `GET /files/:id`, `GET /versions/:id/file`, `GET /versions/:id/chunks`, `POST /files/:id/move` | editor; read: viewer |
| Review | `GET /reviews`, `POST /versions/:id/approve`, `POST /versions/:id/reject` | reviewer |
| Search and Ask | `POST /search`, `POST /ask`, `POST /ask/:id/save-as-page` | viewer (save: editor) |
| Flags and comments | list, resolve, comment CRUD | viewer; resolve: editor |
| Sources | CRUD, `POST /sources/:id/link` (WhatsApp QR), mappings, `POST /sources/:id/sync`, `POST /sources/:id/reconcile` | tenant admin |
| Export | `POST /spaces/:id/export`, `GET /exports/:id` | space admin |
| Admin health | dead-letter jobs, index check results, usage | tenant admin |

Malformed ids answer 404. Another tenant's ids, and spaces the actor cannot read, answer 404, never 403 (from the Shinox
constraints): an actor cannot learn that something exists. A readable resource the actor's role cannot change answers 403
`forbidden`.

## Errors

| Code | Status | When |
|---|---|---|
| `space_not_found`, `page_not_found`, `document_not_found`, `version_not_found`, `source_not_found`, `block_not_found` | 404 | Unknown, another tenant's, or not readable. |
| `parent_not_found` | 404 | Parent is not a live page in the same space. |
| `forbidden` | 403 | Readable, but the role cannot do this. |
| `space_name_taken`, `slug_taken` | 409 | Name in use. |
| `no_changes` | 409 | Snapshot identical to the latest version. |
| `version_not_pending` | 409 | Approve or reject a version that is not waiting. |
| `self_approval` | 409 | Author approving their own snapshot without `allow_self_approval`, or any approval of agent work by an agent. |
| `has_children`, `parent_cycle`, `page_archived` | 409 | Lifecycle rules. |
| `block_recently_edited` | 409 | Agent replacing or deleting a block a person changed recently. |
| `managed_by_source` | 409 | Editing or replacing a synced file by hand. |
| `whatsapp_not_linked` | 409 | Action needs a linked number. |
| `empty_file` | 400 | Empty page body or empty upload. |
| `file_too_large` | 413 | Over the plan's size limit. |
| `unsupported_file_type` | 415 | Type not allowed. |
| `quota_exceeded`, `rate_limited` | 429 | Usage or request limits. |
| `embedding_unavailable`, `extractor_unavailable`, `source_unavailable` | 503 | A dependency is down; the job retries and nothing is half-written. |

The console maps every code to a plain sentence; raw codes are never shown (from the Shinox console plan).

## Audit events

Dotted, one per change: `tenant.created`, `member.invited`, `member.role_changed`, `agent.created`, `agent.token_issued`,
`agent.tool_called`, `space.created`, `space.settings_changed`, `space.grant_changed`, `page.created`, `page.moved`,
`page.archived`, `page.restored`, `page.withdrawn`, `version.created`, `version.approved`, `version.rejected`,
`version.indexed`, `version.restored`, `file.uploaded`, `file.moved`, `document.purged`, `source.created`,
`source.linked`, `source.unlinked`, `source.mapping_changed`, `source.item_deleted`, `flag.raised`, `flag.resolved`,
`export.created`.

## Security

- RLS on every tenant table; the app role cannot bypass it; tests prove a missing `app.tenant_id` returns no rows.
- Secrets envelope-encrypted with a master key from the cloud key service; never logged or returned.
- Files served through the api with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: no-store`, or through short-lived signed URLs for large media (from the Shinox follow-up A notes).
- Agent tokens hashed, scoped and expiring; per-token rate limits.
- The extractor and whatsapp services run without access to other tenants' storage prefixes.
- Backups: Postgres point-in-time recovery and object-storage versioning; restore tested before launch.
- Tenant deletion removes rows, objects and secrets after a grace period, and keeps a minimal audit record.

## Conventions for plans

- Every query filters on `tenant_id` even with RLS on.
- Every job is idempotent and keyed by what it acts on (version id, source item, export id).
- Business rules live in the api and worker, never in the browser; the browser only displays the badge it is given.
- Contracts first: a route's Zod schema is written before its handler.
- Tests: Vitest with PGlite (with the pgvector extension) for services and RLS; an in-process Hocuspocus for collab tests;
  a deterministic fake embedding provider; fake connectors, including a fake Baileys socket that emits messages, edits and
  revokes; Playwright with two browser contexts for co-editing.
- Every slice ends with a written live check against the real stack, like `knowledge-wiki-core-live-check.md`.

## Delivery slices

Each slice gets its own plan in `docs/superpowers/plans/`, written after the previous one is merged.

| Slice | Delivers | Live check proves |
|---|---|---|
| 0. Foundations | Monorepo, tenants, users, memberships, invitations, groups, spaces and grants, RLS, audit, job queue, object storage, contracts, console shell | Two tenants cannot see each other's spaces, by API or by SQL with the app role. |
| 1. Live pages | BlockNote with Hocuspocus, tree, snapshots, review rules, badges, review queue, history and restore, page indexing, hybrid search, Ask with citations | Two people co-edit; a review space holds a snapshot until approved; search cites v2 only after approval. |
| 2. Files | Upload, Inbox, extractor (Docling), viewers, chunk inspector, moves and pinning, change and delete for uploads, upload API source | A PDF, an XLSX and a scanned image become searchable; a replaced file stops answering only once its successor is indexed. |
| 3. Agents | Agent identities and tokens, MCP read and write tiers, block operations, protection, citations, flags | An agent edit shows "awaiting approval"; an edit to a block a person just changed is refused; deleting a cited upload flags the page. |
| 4. WhatsApp | Baileys service, linking, chat mapping, transcripts, media, edits and revokes, direct channel, reconcile | A deleted-for-everyone message leaves the transcript and the index; a file sent to the number lands in Inbox. |
| 5. Drive | OAuth, folder mappings, changes feed, reconcile, Docs and Sheets export | A file trashed in Drive is withdrawn and its citing page flagged. |
| 6. Curator and export | Ingest into pages, flag follow-ups, lint, save answer as page, space export | A new source produces a summary page waiting for approval with citations; an export zip opens in a Markdown editor. |
| 7. Hardening | Quotas and usage, admin health, email notifications, OAuth for MCP clients, Git mirror, evaluation gate in CI | A tenant over quota sees ingest paused with a reason; the evaluation gate blocks a regression. |

## Inspiration from open-source projects

| Idea | Taken from | Where used |
|---|---|---|
| Agents and people co-author one wiki; recently edited human work is protected from agent overwrites; MCP tools in tiers | Civigent | S12, MCP tiers |
| Review workflow for agent changes; claims to stop collisions | Clewwiki | Review rules, protection |
| Real-time CRDT editing with an agent as a peer; a background agent that organises notes into a wiki | inkeep open-knowledge | S2, Curator |
| Content-hash cache, a watcher that runs the same ingest and delete lifecycle, `sources` recorded on every page, two-step ingest, saving answers to the wiki | nashsu/llm_wiki | Change handling, citations, Curator, Save as page |
| Ingest, query and lint as the three wiki operations | Karpathy's LLM Wiki pattern | Curator |
| MCP over HTTP as the shared memory for many agents | kiwiki | MCP |
| Layout-aware parsing; seeing how a document was chunked | RAGFlow (DeepDoc), Docling | Extractor, chunk inspector |
| Graph retrieval modes, multimodal retrieval | LightRAG, RAG-Anything | Later, only if the evaluation set shows multi-hop misses |

## Out of scope for v1

WhatsApp Cloud API (the connector allows it later); audio and video transcription; email, Notion and Git connectors;
two-way Markdown or Obsidian sync and Markdown import; graph retrieval; SSO and SAML; billing (only usage counting);
public or anonymous pages; sharing across tenants; reverting only an agent's changes inside a mixed snapshot; mobile apps;
drag-and-drop of trees between spaces; page templates.

## Open questions

1. **Languages.** If pages are in Malay, Chinese or other languages, full-text search with the `simple` configuration does
   not segment Chinese; vector search carries those queries. Confirm the languages so the evaluation set covers them.
2. **Embedding provider and model.** Choose by running the evaluation set on two or three candidates in slice 1.
3. **File size limit per plan** (50 MB default proposed).
4. **WhatsApp scope.** Whether transcripts per day are the right unit, and how far back to backfill (7 days proposed).
5. **Data residency.** Which cloud region the first deployment uses, and whether any tenant needs its own region.
6. **Self-approval.** Whether `allow_self_approval` should default to on for spaces with a single reviewer.
