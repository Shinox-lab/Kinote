export type ClipName = 'capture' | 'co-edit' | 'review' | 'files' | 'ask' | 'collections' | 'drawings' | 'links';

export type Feature = { title: string; body: string; clip?: ClipName; status: 'built' | 'in-development' };

export const heroClip: ClipName = 'capture';

/** The landing page's alternating feature rows, one per clip after the hero. */
export const rows: Feature[] = [
  {
    title: 'Edit together, live',
    body: 'People and AI agents work on the same page at the same time. Cursors and text show up as they happen, so nobody overwrites anybody.',
    clip: 'co-edit',
    status: 'built',
  },
  {
    title: 'Review where it matters',
    body: 'Turn on review for a space and changes wait for a reviewer before they count. Every page shows where it stands, from "awaiting approval" to "Indexed".',
    clip: 'review',
    status: 'built',
  },
  {
    title: 'Files you can search',
    body: 'Drop in PDFs, Office documents, spreadsheets and images. Kinote previews them, reads the text inside, and search finds it.',
    clip: 'files',
    status: 'built',
  },
  {
    title: 'Ask, with sources',
    body: 'Ask a question in plain words. The answer cites the pages and files it came from, and one click opens the source.',
    clip: 'ask',
    status: 'built',
  },
  {
    title: 'Collections and views',
    body: 'Give a set of pages fields like status, owner and due date. See them as a table, a board, a calendar or a timeline.',
    clip: 'collections',
    status: 'built',
  },
  {
    title: 'Drawings in the page',
    body: 'Sketch a diagram or a floor plan right where you are writing. The drawing stays on the page as a preview.',
    clip: 'drawings',
    status: 'built',
  },
  {
    title: 'Links and comments',
    body: 'Type [[ to link another page, and every page shows what links to it. Comments sit next to the words they are about.',
    clip: 'links',
    status: 'built',
  },
];

/** Smaller features. Unbuilt items keep their label on the same source line so the content check can see it. */
export const grid: Feature[] = [
  { title: 'Spreadsheet editor', body: 'Open an uploaded spreadsheet and edit it in place.', status: 'built' },
  { title: 'Workspaces kept apart', body: 'Each team gets its own workspace, separated in the database by row-level security.', status: 'built' },
  { title: 'Bring your own models', body: 'Connect any OpenAI-compatible provider for search, Ask and routing.', status: 'built' },
  { title: 'Docker Compose', body: 'One command runs the whole stack on your own machine or server.', status: 'built' },
  { title: 'WhatsApp groups', body: 'File what your team says in a group chat, the same way as a note.', status: 'in-development' }, // (In development)
  { title: 'Google Drive sync', body: 'Keep a Drive folder in step with a space.', status: 'in-development' }, // (In development)
  { title: 'MCP for external AI agents', body: 'Let the agents you already use read and write your wiki.', status: 'in-development' }, // (In development)
  { title: 'Self-maintaining wiki', body: 'Follow changed sources, and catch broken links and contradictions.', status: 'in-development' }, // (In development)
  { title: 'Space export', body: 'Download a whole space as Markdown files.', status: 'in-development' }, // (In development)
];
