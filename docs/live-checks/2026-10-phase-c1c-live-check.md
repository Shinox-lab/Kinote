# Phase C1c live check

Status: **not run yet** (2026-10-30). The automated suites passed (`pnpm typecheck`, `pnpm test`: 168 files, 1,604
tests; `pnpm routing:eval`: PASS, 27/27 on the right page, 0 wrong removals). `pnpm test:pg` was not run: the only
Postgres up was the owner's own stack.

Run against `pnpm stack:up` with the real router (`ROUTER_PROVIDER=openai`) and Ask (`ASK_PROVIDER=openai`) models.

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Make page "Clients" a collection with Status (select: Lead, Active, Churned) and Launch date (date). Add row "George": Status Lead, Launch date 15 Nov 2026. | Row shows both values. | |
| 2 | Capture "George launch moved to 1 December". | Receipt line `Launch date: 2026-11-15 (15 November 2026) → 2026-12-01 (1 December 2026)`; George's Launch date is 1 Dec. | |
| 3 | Undo that change. | Launch date back to 15 Nov; the receipt shows it undone. | |
| 4 | Turn on review for the space; capture the same again. | The change shows live, the page waits for review; Search and Ask still say 15 Nov. | |
| 5 | Approve the waiting version. | Ask and Search now say 1 Dec. | |
| 6 | Capture "George status is now Paused" (no such choice). | No field change; the fact lands elsewhere or in Needs a home. No new choice appears. | |
| 7 | Capture "George no longer has a launch date". | A suggestion "Launch date: 2026-12-01 … → empty" with "Approve removal". | |
| 8 | Add two more rows with December and March launch dates; ask "which clients launch in December?". | The answer names the December rows and cites each of them. | |
