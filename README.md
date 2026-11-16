<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/public/logo-dark.svg">
    <img alt="Kinote" src="site/public/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">Write it down once. Kinote files it everywhere it belongs.</h3>

<p align="center">
  A shared wiki for people and AI agents, that you can run yourself.
</p>

<p align="center">
  <a href="https://shinox-lab.github.io/Kinote/">Website</a> ·
  <a href="https://shinox-lab.github.io/Kinote/guide/">Docs</a> ·
  <a href="https://shinox-lab.github.io/Kinote/self-host/">Self-host</a> ·
  <a href="https://shinox-lab.github.io/Kinote/#hosted">Try Kinote</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-6550c9"></a>
  <a href="https://github.com/Shinox-lab/Kinote/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Shinox-lab/Kinote?style=flat&color=6550c9"></a>
</p>

<p align="center">
  <img src="docs/assets/clips/capture.gif" alt="A note about a client call is captured once; Kinote updates the client's page and the roadmap item in two spaces, with a receipt and Undo" width="880">
</p>

## What is Kinote

Kinote is a wiki your team and your AI agents write together. Instead of hunting for the right page every time
something changes, you write it down once (a note, pasted meeting notes, a file) and Kinote edits the right pages
across your spaces, with a receipt, a reason for every change, and Undo. Everything stays searchable, and Ask answers
questions from your pages with citations.

## Features

- **Capture and routing.** Write something once; Kinote finds the pages it affects and edits them. Every change comes
  with a receipt, a reason, Undo, and "Wrong page → move to…".
- **Edit together, live.** People and AI agents on the same page at the same time, with cursors and live text.

<p align="center"><img src="docs/assets/clips/co-edit.gif" alt="Two people edit the same page at the same time" width="880"></p>

- **Review where it matters.** Turn on review for a space and changes wait for a reviewer. Every page shows its state,
  from "awaiting approval" to "Indexed · v7", and any version can be restored.

<p align="center"><img src="docs/assets/clips/review.gif" alt="A change waits for approval; a reviewer approves it and the page is indexed" width="880"></p>

- **Files you can search.** PDFs, Office documents, spreadsheets and images, with previews, text extraction and a
  built-in spreadsheet editor.
- **Search and Ask.** Hybrid search across pages and files, and answers with citations that open the source.
- **Collections and views.** Give pages fields, then see them as a table, board, calendar or timeline.

<p align="center"><img src="docs/assets/clips/collections.gif" alt="A collection shown as a table, a board, a calendar and a timeline" width="880"></p>

- **Drawings, links and comments.** Sketch in the page, link with `[[`, see backlinks, and comment on any text.
- **Yours to run.** Multi-tenant workspaces kept apart by row-level security, Docker Compose, and any
  OpenAI-compatible models for search, Ask and routing.

Being built now:

- **WhatsApp groups as a source** (In development)
- **Google Drive sync** (In development)
- **MCP for external AI agents**: reading is ready (see below); capture and editing are in development
- **Self-maintaining wiki** (In development): follows changed sources, catches broken links and contradictions
- **Space export to Markdown** (In development)

## Quick start

You need Docker and about 4 GB of free memory.

```sh
git clone https://github.com/Shinox-lab/Kinote.git
cd Kinote && cp .env.example .env   # then fill in the six secrets
docker compose up -d
```

Open `http://localhost:8081` and sign up. The [self-hosting guide](https://shinox-lab.github.io/Kinote/self-host/)
covers the secrets, connecting models, reverse proxies, storage, upgrades and backups.

## Connect an agent

AI tools such as Claude Code can read your wiki over MCP (Model Context Protocol), and file what they learn into it
through Capture. Each agent has its own tokens and sees only the spaces you grant it, and never more than the person
who owns it can see.

**Sign in from the client.** Any member can connect a client that supports MCP sign-in, with no token to copy. For
Claude Code:

```sh
claude mcp add --transport http kinote https://<your-kinote>/mcp
```

Then run `/mcp` in Claude Code and choose to authenticate. Your browser opens Kinote's sign-in page: pick the
workspace, name the agent and tick the spaces it may read. Kinote creates a read-only agent owned by you; admins see
it in **Settings → Agents**, where revoking its token disconnects the client. The token lasts an hour and the client
renews it by itself for up to 90 days after it was last used.

**Or issue a token.** For headless agents, CI and clients without sign-in:

1. In **Settings → Agents**, add an agent, choose its access to each space (Viewer or Editor), and issue a token with
   the **Read** scope, plus **Capture** if it may file information. The token is shown once.
2. Connect the client. For Claude Code:

   ```sh
   claude mcp add --transport http kinote https://<your-kinote>/mcp --header "Authorization: Bearer <token>"
   ```

   Any MCP client that supports Streamable HTTP works the same way: the endpoint is `/mcp` and the token is a
   Bearer header.

A Read token gets five tools, and a Capture token two more:

| Tool | What it does |
| --- | --- |
| `kinote_browse` | The map: spaces and their page trees with a one-line summary per page. |
| `kinote_search` | Passages that match a query, with their page, section and block IDs, or the pages about it. |
| `kinote_read` | A page's outline, one section, or the whole page, with a cursor for long pages. |
| `kinote_related` | What connects to a page or a named thing: relationships, mentions, links in. |
| `kinote_ask` | An answer written from the wiki with its sources (costs an AI action). |
| `kinote_capture` | Files new information through routing, with a receipt; `preview: true` shows where it would go first. |
| `kinote_capture_action` | Status, answer a routing question, undo, move, or apply/cancel a preview. |

Tokens expire after 90 days unless you choose otherwise (1 to 365), and an admin can revoke one or disable an agent at
any time. Each agent has its own rate limits and a daily limit of AI actions (100 unless you set another), and every
tool call is recorded in the audit log. The `edit` scope already exists on tokens; the tool that uses it arrives later.

**Capture from an agent.** An agent files information the way a person does on the Capture page: routing decides
where each fact belongs, explains why, skips what is already known, and every change can be undone.

- New agents are set to **Always review its changes**: their changes wait for review even in spaces without review.
  Switch it off per agent in **Settings → Agents**.
- Routing questions go to the agent's owner on their Capture page, where they also see, undo and place the agent's
  captures. Turn on **Agents may answer routing questions** to let agents answer themselves.
- With `preview: true` nothing changes until the agent applies the plan, so it can show its user where each fact would
  go, skip or re-place facts, or cancel and edit by hand.
- A `source` (a URL or ticket ID) makes a retry safe: the same source and text return the first capture.
- **Stop and undo…** on an agent disables it and undoes what it filed since a time you choose.

Notes typed into a capture, by a person or an agent, can say how to file it: "make a new page for this", "only update
the pages", "put it under Clients/George", "keep the file as a copy" or "don't keep the file". Text inside an attached
file never counts as an instruction. Without one, Capture decides by meaning whether an attached file is a record worth
keeping (a contract, a report, a deck) or only carried facts, which leaves it in the Inbox.

## How it works

<p align="center"><img src="site/public/architecture.svg" alt="Kinote's services" width="820"></p>

The web app (React and BlockNote) talks to a Fastify API and a live-editing server (Hocuspocus and Yjs) through one
nginx entry point. A worker runs indexing, file reading and routing as idempotent jobs from a queue in PostgreSQL, which
also holds the pgvector search index and enforces row-level security per workspace. Files live in S3-compatible
storage, and a Docling service reads them. More in the
[contributing docs](https://shinox-lab.github.io/Kinote/contributing/).

## Contributing

Contributions are welcome. Start with [Repo layout and services](https://shinox-lab.github.io/Kinote/contributing/)
and [Development](https://shinox-lab.github.io/Kinote/contributing/development), then:

```sh
pnpm install
pnpm test
```

## License

[MIT](LICENSE) © Shinox-lab
