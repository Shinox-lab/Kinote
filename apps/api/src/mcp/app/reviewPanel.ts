/**
 * The Kinote review panel (MCP App `ui://kinote/review`), bundled by esbuild into one inline script. The host
 * shows it for `kinote_review`: one card per waiting item, approved or rejected through the app-only tools as the
 * agent's owner; each decision is shared with the model.
 */
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import {
  age,
  applyOutcome,
  cardsFrom,
  contextLine,
  fileSummary,
  kindLabel,
  lineDiff,
  type CardState,
  type Decision,
  type DecideReply,
  type ReviewList,
  type ReviewPanelItem,
} from './reviewLogic.js';

type ToolReply = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

const app = new App({ name: 'Kinote review panel', version: '1' }, {});
const root = document.getElementById('root')!;
let args: { page_id?: string; mine_only?: boolean } = {};
let view: { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'list'; cards: CardState[]; canDecide: boolean; empty: string | null; url: string | null } = {
  kind: 'loading',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const textOf = (r: ToolReply) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

async function call(name: string, a: Record<string, unknown>): Promise<ToolReply> {
  return (await app.callServerTool({ name, arguments: a })) as ToolReply;
}

async function load() {
  view = { kind: 'loading' };
  render();
  try {
    const res = await call('kinote_review_list', args);
    if (res.isError || !res.structuredContent) {
      view = { kind: 'error', message: textOf(res) || 'Kinote could not list what is waiting.' };
    } else {
      const list = res.structuredContent as ReviewList;
      const url = list.reviews_url && /^https?:/.test(list.reviews_url) ? list.reviews_url : null;
      view = { kind: 'list', ...cardsFrom(list), url };
    }
  } catch {
    view = { kind: 'error', message: 'Kinote could not be reached. Try Refresh.' };
  }
  render();
}

async function decide(index: number, decision: Decision, note: string) {
  if (view.kind !== 'list') return;
  const card = view.cards[index]!;
  view.cards[index] = { ...card, busy: true };
  render();
  let reply: DecideReply;
  try {
    const res = await call('kinote_review_decide', {
      type: card.item.type,
      id: card.item.id,
      decision,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    reply = res.isError ? { ok: false, message: textOf(res) } : ((res.structuredContent as DecideReply | undefined) ?? { ok: false, message: textOf(res) });
  } catch {
    reply = { ok: false, message: 'Kinote could not be reached. Try again.' };
  }
  if (view.kind !== 'list') return;
  view.cards[index] = applyOutcome(card, reply, decision);
  render();
  if (reply.ok) {
    await app.updateModelContext({ content: [{ type: 'text', text: `Your user, in the Kinote review panel: ${contextLine(card.item, decision)}` }] }).catch(() => undefined);
  }
}

function link(url: string, label: string): HTMLElement {
  const a = el('a', { href: url }, label);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    void app.openLink({ url });
  });
  return a;
}

function diffView(before: string | null, after: string | null): HTMLElement | null {
  if (before === null && after === null) return null;
  const box = el('div', { class: 'diff' });
  for (const line of lineDiff(before ?? '', after ?? '')) box.append(el('span', { class: line.op }, line.text || ' '));
  return box;
}

/** A file version: its versions and sizes, image previews side by side, and links that open outside the panel. */
function fileView(item: ReviewPanelItem): HTMLElement {
  const f = item.file!;
  const box = el('div', { class: 'file' }, el('p', { class: 'meta' }, fileSummary(item)));
  const previews = [f.preview.before, f.preview.after].filter((p): p is string => p !== null);
  if (previews.length > 0) {
    const row = el('div', { class: 'previews' });
    for (const p of previews) row.append(el('img', { src: p, alt: '' }));
    box.append(row);
  }
  const links: HTMLElement[] = [];
  if (f.before?.url) links.push(link(f.before.url, `Download v${f.before.version}`));
  if (f.after.url) links.push(link(f.after.url, `Download v${f.after.version}`));
  if (links.length > 0) box.append(el('div', { class: 'actions' }, ...links));
  if (item.before === null && item.after === null) box.append(el('p', { class: 'muted' }, 'No text to compare: download the versions to see the change.'));
  return box;
}

function cardView(card: CardState, index: number, canDecide: boolean, url: string | null): HTMLElement {
  const { item } = card;
  const out = el(
    'div',
    { class: 'card' },
    el('h2', {}, item.file ? kindLabel(item) : `${kindLabel(item)} · ${item.page.title}`),
    el('p', { class: 'meta' }, `${item.page.space} · by ${item.proposer.name} · ${age(item.created_at)}`)
  );
  if (item.reason) out.append(el('p', {}, el('strong', {}, 'Why: '), item.reason));
  if (item.kind === 'archive') {
    out.append(el('p', {}, item.sub_pages ? `It has ${item.sub_pages} sub-pages: they must be moved or deleted first.` : 'The page is archived: a person can restore it.'));
  } else {
    if (item.file) out.append(fileView(item));
    const diff = diffView(item.before, item.after);
    if (diff) out.append(diff);
  }

  if (card.outcome) {
    out.append(el('p', { class: card.outcome.kind === 'done' ? 'done' : 'error', role: 'status' }, card.outcome.text));
    if (card.outcome.kind === 'done') return out;
  }
  if (!canDecide) {
    out.append(el('div', { class: 'actions' }, url ? link(url, 'Open in Kinote') : el('span', { class: 'muted' }, 'Decide this in Kinote.')));
    return out;
  }
  if (!item.decidable) {
    out.append(el('p', { class: 'muted' }, item.why_not ?? 'Someone else decides this.'));
    return out;
  }
  const note = el('input', { class: 'note', type: 'text', maxlength: '300', placeholder: 'Note (optional)', 'aria-label': 'Note' }) as HTMLInputElement;
  const approve = el('button', { type: 'button', class: 'primary' }, item.kind === 'archive' ? 'Delete page' : 'Approve') as HTMLButtonElement;
  const reject = el('button', { type: 'button' }, 'Reject') as HTMLButtonElement;
  approve.disabled = reject.disabled = card.busy;
  approve.addEventListener('click', () => void decide(index, 'approve', note.value));
  reject.addEventListener('click', () => void decide(index, 'reject', note.value));
  if (item.type === 'version') out.append(note);
  out.append(el('div', { class: 'actions' }, reject, approve));
  return out;
}

function render() {
  const refresh = el('button', { type: 'button' }, 'Refresh') as HTMLButtonElement;
  refresh.disabled = view.kind === 'loading';
  refresh.addEventListener('click', () => void load());
  const body: Array<Node | string> = [el('div', { class: 'toolbar' }, el('h1', {}, 'Waiting for your review'), refresh)];
  if (view.kind === 'loading') body.push(el('p', { class: 'muted' }, 'Loading…'));
  else if (view.kind === 'error') body.push(el('p', { class: 'error', role: 'alert' }, view.message));
  else if (view.empty) body.push(el('p', { class: 'muted' }, view.empty));
  else {
    const { canDecide, url } = view;
    if (!canDecide) body.push(el('p', { class: 'muted' }, "This agent's changes are decided in Kinote."));
    view.cards.forEach((card, i) => body.push(cardView(card, i, canDecide, url)));
  }
  root.replaceChildren(...body);
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.ontoolinput = (params) => {
  const a = (params.arguments ?? {}) as Record<string, unknown>;
  args = {
    ...(typeof a.page_id === 'string' && a.page_id ? { page_id: a.page_id } : {}),
    ...(a.mine_only === true ? { mine_only: true } : {}),
  };
  void load();
};
app.ontoolresult = (params) => {
  if (params.isError) {
    const text = (params.content ?? []).map((c) => ('text' in c ? c.text : '')).join('\n');
    view = { kind: 'error', message: text || 'Kinote could not open the review panel.' };
    render();
  }
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);

render();
void app.connect().then(() => applyContext(app.getHostContext()));
