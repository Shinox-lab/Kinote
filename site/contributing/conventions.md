# Conventions

## Rules Kinote keeps

Every change is reviewed against these.

1. **The wiki owns the content; the search index is derived from it.** The index can always be rebuilt from page and
   file versions.
2. **One place for files and approval state.** A document's bytes and its review state live in one registry.
3. **Nothing reaches the index without passing its space's rules.** In a space with review on, a change waits for a
   person. AI agents can never approve.
4. **Access belongs to the space.** Moving a document to another space changes who can find it at once.
5. **A person's decision outranks automation.** A block someone edited recently is never replaced by an agent, and a
   document someone moved is never moved back by a sync.
6. **Nothing typed is lost.** Live content is saved continuously. Restoring a version adds a new version; it never
   rewrites history.
7. **Citations show only indexed facts:** the title, version number and date of the version that was found.
8. **The title is part of the indexed text,** so renaming a page is a content change.
9. **Removing is fast; adding is gated.** Withdrawing or archiving needs no approval and takes effect in the index
   immediately.
10. **Markdown is the reviewed and indexed form of a page.** The editor's own format is stored for editing and
    converted to Markdown on the server.
11. **File content never runs.** SVG and HTML uploads are refused, Markdown is parsed, and viewers fall back to a
    download.
12. **Permissions are applied inside the search query,** before ranking. A model can rank or drop a passage, never
    grant access to one.
13. **Retrieved text is data, not instructions.** Nothing in a page or file can change a permission, a status or a
    setting.
14. **Every actor is recorded.** People, agents and integrations each have an identity on every change.

## Writing code

- **Filter by workspace in every query,** even though row-level security would catch a mistake.
- **Make every background job idempotent** and key it by what it acts on (a version, a file, a capture), so running it
  twice is harmless.
- **Keep business rules on the server.** The browser displays what the server decides; for example, the API composes a
  page's status text and the web app only colours it.
- **Write the contract first.** A route's Zod schema in `packages/contracts` comes before its handler.
- **Test first.** Write a test that fails, then the code that makes it pass. Use PGlite for database and row-level
  security tests, an in-process Hocuspocus for live editing, the deterministic providers instead of real models, and
  Playwright with two browser contexts for anything people do together.
- **Match the code around you:** its naming, comment density and idioms.
