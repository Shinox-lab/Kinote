# Phase C2: Excalidraw drawings — design

Status: draft, 2026-10-30. The other half of Phase C (collections were C1). Builds on
`docs/kinote-standalone-design.md` and the collections spec (`2026-10-29-phase-c-collections-design.md`), whose
fields pattern this follows. Where they differ, this wins for drawings.

The owner asked for drawings that "just work" for the many things Excalidraw is used for (diagrams, flows, sketches,
wireframes, whiteboards) and handed the design calls to me. Every decision below is therefore *my call* unless marked
otherwise; the owner can overturn any of them.

## Why

Teams explain systems, flows and ideas with sketches. Today a sketch lives in another tool and comes into the wiki as a
screenshot, which goes stale, can't be edited together, and isn't searchable. Excalidraw is the tool people already
reach for. Putting it inside pages gives drawings the same live editing, history, review and search as text.

## Goals

1. **A drawing is part of a page.** Insert one from the slash menu ("Drawing"), as many per page as wanted, with text
   above and below it.
2. **Drawn together, live.** Two people (or more) draw in the same drawing at once, see each other's pointers, and never
   lose each other's strokes.
3. **Same rules as text.** A drawing change marks the page changed, is snapshotted into a version, follows the space's
   review rule, shows in history, and comes back with "Restore this version".
4. **Reviewers can see it.** The review screen and history show a drawing before and after, so nobody approves a change
   they can't see.
5. **Searchable.** The words written in a drawing (text, labels on shapes and arrows) are indexed with the page, so Search
   and Ask find it.
6. **The console stays fast.** Excalidraw loads only when a page with a drawing is opened.

## Non-goals

- Images inside drawings (pasted or inserted pictures). Put the image on the page beside the drawing. Excalidraw keeps
  image bytes in the scene, which would bloat the live page document and its every version; a later slice can store them
  as file documents.
- Drawings as their own document kind in the tree, or a drawing shared between pages.
- Agents or the routing engine editing drawings. They read a drawing's text; they never change it.
- Excalidraw's own sharing, cloud save, "open file", and its own live-collaboration room. Kinote is the room.
- Text recognition in hand-drawn strokes, and AI diagram generation.
- Mobile apps (dropped by the owner). Phone-width browsers must not break, but drawing there is best effort.

## Anti-goals

- **Strokes lost in a co-edit.** Two people drawing at once must both keep their work; "last save wins" on a whole
  scene would fail this even if everything else works.
- **A drawing change that skips review.** In a review space, a drawing change waits like a text change; Search and Ask
  keep the approved words until then.
- **A heavy console for everyone.** Pages without drawings must not download Excalidraw.
- **Assets from the internet.** Excalidraw fetches fonts from a CDN by default; a self-hosted Kinote must serve them
  itself.

## Decisions

**D1. A drawing is a block.** New BlockNote block `drawing` with props `{ drawingId: uuid, title: string (default ''),
height: number (px, default 480, 240–1200) }`. The block holds no scene: the scene lives beside the blocks (D2), keyed
by `drawingId`. The block shows the drawing inline at its height, a title above it (editable, "Untitled drawing"
placeholder), and a button to open it full screen. Editors can resize the height by dragging the bottom edge.

**D2. The scene lives in the page document.** The page's Y.Doc gains a `drawings` Y.Map: `drawingId → Y.Map(elementId →
element)`, where an element is Excalidraw's element JSON stored as a plain object. One entry per element is what makes
co-editing merge: two people changing different elements never collide; two changing the same element keep the one with
the higher Excalidraw `version` (ties: lower `versionNonce`), which is Excalidraw's own reconcile rule. Deleted elements
stay as Excalidraw's `isDeleted: true` tombstones so a late edit can't bring them back. Order on the canvas is the
elements' fractional `index` property (Excalidraw ≥ 0.17), so no array order is needed. No app state is shared (zoom,
scroll, selected tool and theme are each viewer's own).

**D3. The binding.** Kinote writes its own small binding between Excalidraw and the Y.Map, in the web app:
- On Excalidraw's `onChange`, every element whose `version` differs from the stored one is written in one Yjs
  transaction (origin: this client), throttled to at most one write per 50 ms while drawing and flushed on pointer up.
- On a remote change to the Y.Map, the changed elements are merged into the scene with Excalidraw's
  `reconcileElements` and `updateScene`; local in-progress edits win as Excalidraw's rule says.
- Pointers: each client puts `{ drawingId, pointer: {x, y}, button }` in its page awareness state; the block shows other
  people's pointers with their name and presence colour through Excalidraw's `collaborators`.
I chose this over the `y-excalidraw` package: it is small, its last release is from 2024, and a binding we own keeps
the element-map shape that versions and indexing rely on.

**D4. Limits.** At most 5,000 live (non-deleted) elements and 1 MB of element JSON per drawing. Past either, the
drawing shows "This drawing is full" and stops accepting new elements (edits of existing ones still work). Tombstones
are not counted. Collab cannot reject a websocket edit, so the limit is enforced by the editor and every server reader
tolerates more (it reads the first 5,000 elements by `index`).

**D5. Attribution and protection.** Collab counts a change to `drawings` as a page change (as it does for `meta` and
`fields`): the page is marked changed since its snapshot and the contributor is recorded. It records `block_activity`
under the drawing block's id, so authorship colours and agent protection work with no new mechanism.

**D6. Versions.** `versions` gains `drawings jsonb`: `{ [drawingId]: Element[] }`, only drawings that a block of this
version references, only non-deleted elements, sorted by `index`. `takePageSnapshot` writes it; the content hash covers it
(canonical JSON), so moving a shape makes a new version. Pages without drawings hash exactly as before (no new versions
on upgrade), the same rule fields used. A page whose only content is a drawing is not empty: it gets snapshotted,
reviewed and indexed.

**D7. Indexed text.** A drawing's indexed text is one line, `Drawing: {title or 'Untitled drawing'}`, then the text of
its text elements (free text, and labels bound to shapes and arrows), one per line, in `index` order, whitespace
collapsed, at most 200 lines. The snapshot puts this text into the drawing block's in-memory copy before the Markdown
conversion and before storing `versions.blocks` (a hidden `text` prop the server's render and `flattenBlocks` read), so
Markdown, chunking, page cards, the review block diff and the routing engine all see it through the paths that exist.
The live document is never written by the server for this.

**D8. Review and history show the drawing.** Wherever a version's blocks are shown (review queue, history compare,
diff panel), a drawing block renders read-only from that version's `drawings` (Excalidraw's `exportToSvg` on the
client). In the block diff, a changed drawing shows before and after side by side, with a line "3 shapes added, 1
changed, 2 removed" (counted by element id and `version`). A drawing whose elements didn't change counts as unchanged
even if its block moved.

**D9. Restore.** "Restore this version" restores drawings too: collab's replace path gains a `drawings` payload that
replaces each referenced drawing's element map with the version's elements (elements not in the version become
tombstones with a bumped `version`, so open editors drop them). The internal body limit grows to fit a page at the D4
limits (four full drawings at least).

**D10. Readers and editors.** Viewers see the drawing in Excalidraw's view mode: pan, zoom, full screen, export, no
edits. Editors get the full editing UI minus what Kinote doesn't offer: no image tool, no "open", no "save to", no
Excalidraw live-collaboration button. Pasted images are refused with "Images in drawings aren't supported yet. Add the
image to the page instead." The library panel stays (stored per browser). Export to PNG and SVG and "copy to clipboard"
stay. The canvas follows the console's light or dark theme.

**D11. Loading and assets.** The drawing block's view is a lazy chunk: `@excalidraw/excalidraw` (pinned to `0.18.1`,
MIT) and its CSS load on first render of a drawing block, with a sized placeholder meanwhile so the page doesn't jump.
Its fonts are copied into the web build and served by Kinote (`window.EXCALIDRAW_ASSET_PATH`), never fetched from a CDN.
If the chunk fails to load, the block says "This drawing couldn't load" with Retry; the drawing's text (D7) is shown
below so the content is still readable.

**D12. Copying and deleting.** Duplicating or pasting a drawing block within the same page gives the copy a new
`drawingId` and copies its elements (two blocks never share a scene). Pasted into another page, it is copied the same
way through the clipboard's block JSON plus the scene (Kinote's own clipboard payload); pasted outside Kinote it is an
image of the drawing. Deleting the block leaves its scene in the live document unreferenced; it is never read, never
versioned, and comes back if the deletion is undone or an older version is restored.

**D13. The engine and agents.** The routing engine sees a drawing block as its D7 text and may cite it, but never
targets it: a planned replace, remove or insert-into of a drawing block is dropped. MCP `read_page` returns the same
text. No agent tool edits drawings in v1.

## Edge cases

- Two people move the same shape at once: the higher Excalidraw `version` wins, both are recorded as contributors.
- Someone deletes a shape while another is moving it: the tombstone or the move wins by `version`; never a crash.
- A drawing open full screen when someone else deletes its block: the overlay closes with "This drawing was removed".
- A page restored to a version from before the drawing existed: the block goes; the scene stays unreferenced (D12).
- A review space: a person's drawing edit shows live at once; the status chip says the page waits for review; Search and
  Ask keep the approved words.
- A drawing with text in many languages: indexed as typed (`simple` text search; vectors carry the meaning).
- A page export (later slice): a drawing is written as `.excalidraw` JSON plus an SVG; the version data supports it.

## Delivery

One part, merged on its own:
- `drawing` block (web and server schemas), the binding, pointers, limits, lazy loading and self-hosted fonts.
- Collab attribution, `versions.drawings`, snapshot hash and "not empty" rule, indexed text, restore.
- Review, history and diff rendering of drawings.
- The engine's drop rule for drawing blocks.

## Left to the builder

- The look of the drawing block (title, resize handle, full-screen overlay) within the existing page style.
- The exact throttling of writes and the pointer update rate, within D3's bounds.
- How the "shapes added/changed/removed" line is laid out in the diff.
- How the lazy chunk and fonts are wired into the Vite build.
