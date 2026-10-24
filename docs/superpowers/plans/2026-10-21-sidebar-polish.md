# Sidebar polish: no clickable space, drag to move, right-click rename, create space, file screen

Approved in chat on 2026-10-21 (the user answered "Correct" to the playback and to the
recommended options: toggle-only space row, content-first file screen, consistency pass).

## What changes

1. **Space row is not a link.** In the sidebar the space name expands/collapses the tree
   instead of navigating to `/w/$tenantSlug/s/$spaceSlug` (that route stays: the breadcrumb
   and the workspace home still use it).
2. **Drag to move.** A page or file row is draggable. Dropping it on a page row makes it a
   child of that page; dropping it on a space row moves it to that space (top level). The
   server's existing `movePage` / `moveFile` endpoints do the work, so the cross-space rules
   (Inbox, review, chunks) stay in one place.
3. **Right-click rename.** A context menu on a page or file row offers Rename; the title
   becomes an inline text field (Enter saves, Escape cancels).
   - A file rename updates `documents.title`.
   - A page rename also updates the live collab document (the page screen shows the live
     title), through a new `POST /internal/set-title` on the collab server.
4. **Create space.** A "New space" button in the sidebar's Spaces heading, for tenant
   admins and owners (the server only lets them create spaces).
5. **File screen is content-first.** Title and status at the top, the preview as the hero,
   chunks and versions as the secondary part below it.
6. **Consistency pass** over the sidebar and the file screen (spacing, hover, icons).

### As built (2026-10-21)

- Download, Replace and Retry stay visible buttons instead of moving into the "…" menu: a
  viewer has no menu at all (the "…" only holds what an editor may do), and a download is
  the one thing a viewer comes for.
- The chunks and versions sit side by side below the preview rather than in collapsed
  sections: the chunk list is already collapsed behind "Show search chunks", and the
  version list has to stay readable at a glance.
- The space row is one button ("Expand Docs" / "Collapse Docs") that holds the chevron,
  the icon and the name, so the tree has a single control per space.

## Files

- `packages/contracts/src/index.ts` — `UpdateTitleRequestSchema`, `CollabSetTitleRequestSchema`,
  two new audit event types.
- `apps/collab/src/{origin,directSession,internal,server}.ts` — a `human` direct origin and
  the `set-title` internal endpoint.
- `apps/api/src/collab/client.ts` — `setTitle` on the collab client.
- `apps/api/src/routes/{pages,files}.ts` + `apps/api/src/server.ts` — the two rename routes.
- `apps/web/src/lib/api.ts` — `renamePage`, `renameFile`.
- `apps/web/src/components/sidebar/{SpacesSection,ContextMenu,TitleInput}.tsx` — the sidebar work.
- `apps/web/src/components/{FileMenu,ChunkInspector}.tsx`, `apps/web/src/routes/file.tsx` — the file screen.

## Tests

- `apps/api/test/rename.test.ts` — renaming a page (live title) and a file, and the refusals.
- `e2e/sidebar.spec.ts` — the space name is a button now, not a link; a page is renamed from
  the sidebar, a space is made from it, and a page is dragged under another page.
