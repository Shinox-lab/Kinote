/**
 * The Kinote file panel (MCP App `ui://kinote/upload`), bundled by esbuild into one inline script. The host
 * shows it for `kinote_upload`: the person drops the original file, it is uploaded through the app-only tools and
 * filed by the agent's description, and the receipt is shown here and shared with the model.
 */
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { linkify, uploadFile, type PanelForm, type ToolReply } from './panelLogic.js';

type State =
  | { kind: 'waiting' }
  | { kind: 'chosen'; file: File }
  | { kind: 'uploading'; file: File; sent: number; abort: AbortController }
  | { kind: 'refused'; message: string }
  | { kind: 'done'; receipt: string };

const app = new App({ name: 'Kinote file panel', version: '1' }, {});
const root = document.getElementById('root')!;
const form: PanelForm = { about: '' };
let fileHint: string | null = null;
let state: State = { kind: 'waiting' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** The receipt without the `<kinote:content>` markers the model reads. */
function plainReceipt(text: string): string {
  return text.replace(/<\/?kinote:content[^>]*>\n?/g, '').trim();
}

function setState(next: State) {
  state = next;
  render();
}

function chooseFile(file: File | undefined) {
  if (!file || state.kind === 'uploading' || state.kind === 'done') return;
  setState({ kind: 'chosen', file });
}

function picker(label: string): HTMLElement {
  const input = el('input', { type: 'file', id: 'file', 'aria-label': 'Choose file' }) as HTMLInputElement;
  input.addEventListener('change', () => chooseFile(input.files?.[0]));
  const button = el('button', { type: 'button', class: 'secondary' }, label);
  button.addEventListener('click', () => input.click());
  return el('span', {}, input, button);
}

async function capture(file: File) {
  const abort = new AbortController();
  setState({ kind: 'uploading', file, sent: 0, abort });
  const call = (name: string, args: Record<string, unknown>) => app.callServerTool({ name, arguments: args }) as Promise<ToolReply>;
  const out = await uploadFile(
    file,
    call,
    (sent) => {
      if (state.kind === 'uploading') {
        state.sent = sent;
        updateProgress();
      }
    },
    form,
    abort.signal
  );
  if (!out.ok) return setState({ kind: 'refused', message: out.message });
  setState({ kind: 'done', receipt: out.receipt });
  await app.updateModelContext({ content: [{ type: 'text', text: `Your user added ${file.name} through the Kinote panel.\n${out.receipt}` }] }).catch(() => undefined);
}

function updateProgress() {
  if (state.kind !== 'uploading') return;
  const bar = document.getElementById('progress') as HTMLProgressElement | null;
  if (bar) bar.value = state.sent / state.file.size;
  const label = document.getElementById('progress-label');
  if (label) label.textContent = `Uploading ${size(state.sent)} of ${size(state.file.size)}`;
}

function receiptView(text: string): HTMLElement {
  const box = el('div', { class: 'receipt' });
  for (const part of linkify(plainReceipt(text))) {
    if ('text' in part) box.append(part.text);
    else {
      const a = el('a', { href: part.url }, part.url);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        void app.openLink({ url: part.url });
      });
      box.append(a);
    }
  }
  return box;
}

function render() {
  const body: Array<Node | string> = [el('h1', {}, 'Add a file to Kinote')];
  if (form.about) body.push(el('p', { class: 'notes' }, el('strong', {}, 'About: '), form.about));
  if (form.place_under) body.push(el('p', { class: 'notes' }, el('strong', {}, 'Goes under: '), form.place_under));

  if (state.kind === 'waiting' || state.kind === 'chosen' || state.kind === 'refused') {
    const zone = el('div', { class: 'drop', id: 'drop' });
    if (state.kind === 'chosen') {
      zone.append(el('p', { class: 'file' }, el('strong', {}, state.file.name), ` · ${size(state.file.size)}`), picker('Choose another'));
    } else {
      zone.append(el('p', {}, fileHint ? 'Drop ' : 'Drop the file here', ...(fileHint ? [el('em', {}, fileHint), ' here'] : [])), picker('Choose file'));
    }
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      chooseFile(e.dataTransfer?.files?.[0]);
    });
    if (state.kind === 'refused') body.push(el('p', { class: 'error', role: 'alert' }, state.message));
    body.push(zone);
    const go = el('button', { type: 'button', class: 'primary', id: 'capture' }, 'Upload') as HTMLButtonElement;
    go.disabled = state.kind !== 'chosen';
    if (state.kind === 'chosen') {
      const file = state.file;
      go.addEventListener('click', () => void capture(file));
    }
    body.push(el('div', { class: 'actions' }, go));
  } else if (state.kind === 'uploading') {
    const abort = state.abort;
    const cancel = el('button', { type: 'button', class: 'secondary' }, 'Cancel');
    cancel.addEventListener('click', () => abort.abort());
    body.push(
      el('p', { class: 'file' }, el('strong', {}, state.file.name)),
      el('progress', { id: 'progress', max: '1', value: '0' }),
      el('p', { id: 'progress-label', class: 'muted' }),
      el('div', { class: 'actions' }, cancel)
    );
  } else {
    body.push(receiptView(state.receipt));
  }
  root.replaceChildren(...body);
  updateProgress();
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.about === 'string') form.about = args.about;
  if (typeof args.place_under === 'string' && args.place_under) form.place_under = args.place_under;
  if (typeof args.file_name === 'string' && args.file_name) fileHint = args.file_name;
  render();
};
app.ontoolresult = (params) => {
  // A refusal from kinote_upload (no credits, no space to edit): show it instead of the drop zone.
  if (params.isError && state.kind === 'waiting') {
    const text = (params.content ?? []).map((c) => ('text' in c ? c.text : '')).join('\n');
    setState({ kind: 'refused', message: text || 'Kinote could not open the file panel.' });
  }
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);

render();
void app.connect().then(() => applyContext(app.getHostContext()));
