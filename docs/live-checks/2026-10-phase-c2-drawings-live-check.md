# Phase C2 drawings live check

Status: **not run yet** (2026-10-30). Automated: `pnpm test` (174 files, 1,653 tests) and `pnpm e2e:local
e2e/drawings.spec.ts` (4 browser tests: two people drawing at once, review then search, Excalidraw loaded only with a
drawing and fonts from Kinote, restore) pass. `pnpm test:pg` was not run: the only Postgres up was the owner's own stack.

Run against `pnpm stack:up` (rebuilt web image, so `dist/excalidraw-assets` and the nginx route are in it).

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Open a page with no drawing; in the network panel, look for Excalidraw's chunk. | Not downloaded. | |
| 2 | `/drawing` on an empty line. | A drawing block with "Untitled drawing", a canvas 480 px high; fonts load from `/excalidraw-assets/fonts/`, nothing from esm.sh. | |
| 3 | Two browsers (two people) on the page draw at the same time; reload both. | Both see each other's pointer with a name; both keep every shape. | |
| 4 | Paste an image into the canvas; drop an image file on it. | "Images in drawings aren't supported yet. Add the image to the page instead." No image stays. | |
| 5 | Drag the bottom edge; open Full screen; Close. | Height stays between 240 and 1200 px and is kept; full screen opens and closes. | |
| 6 | In a review space, write "Payment flow" in the drawing, submit, approve as another person, search "Payment flow". | Found only after approval; the review shows the drawing before/after with "N shapes added…". | |
| 7 | Move a shape, snapshot, then restore the earlier version. | Open editors show the shape back where it was; shapes added since are gone. | |
| 8 | Duplicate the drawing block (side menu). Edit the copy. | The original doesn't change. | |
| 9 | Open the page as a viewer. | View mode: pan, zoom, export; no editing. | |
