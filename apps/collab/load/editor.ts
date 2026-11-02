import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { LatencyMeter, type LatencyStats } from './metrics.js';
import { sleep } from './util.js';

/** BlockNote's block fragment; the same name the collab server and snapshots use. */
const BLOCK_FRAGMENT = 'document-store';
const MAX_TEXT_LENGTH = 4000;
const CHARS = 'abcdefghijklmnopqrstuvwxyz ';

export interface LoadAccount {
  token: string;
  user: { id: string; name: string; email: string };
}

export interface EditorOptions {
  apiUrl: string;
  collabUrl: string;
  tenantId: string;
  spaceId: string;
  pageId: string;
  user: LoadAccount;
  /** Which block this editor types into when the page has several. */
  index: number;
  typingMs: number;
  pingMs: number;
  /** 0 disables page reads. */
  readMs: number;
  /** 0 disables page navigation. */
  navigateMs: number;
  /** Spread each navigation by up to this many extra milliseconds. */
  navigateJitterMs: number;
  /** How long to read a newly opened page before typing again. */
  navReadMs: number;
  onLatency?: (ms: number) => void;
  onReadLatency?: (ms: number) => void;
  onError?: (error: unknown) => void;
}

export interface EditorStats {
  edits: number;
  reads: number;
  navigations: number;
  errors: number;
  latency: LatencyStats;
  readLatency: LatencyStats;
}

/** The text node inside each block of a BlockNote page, in document order. */
export function findTextTargets(doc: Y.Doc): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement, insideBlock: boolean): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        walk(child, insideBlock || child.nodeName === 'blockContainer');
      } else if (child instanceof Y.XmlText && insideBlock) {
        out.push(child);
      }
    }
  };
  walk(doc.getXmlFragment(BLOCK_FRAGMENT), false);
  return out;
}

/**
 * The text this editor types into: an existing block, or a new paragraph when the page has none.
 * `index` wraps, so every editor on a page has somewhere to type.
 */
export function ensureTextTarget(doc: Y.Doc, index: number): Y.XmlText {
  const existing = findTextTargets(doc);
  if (existing.length > 0) return existing[index % existing.length]!;

  const fragment = doc.getXmlFragment(BLOCK_FRAGMENT);
  let group = fragment.get(0);
  if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
    group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
  }
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', crypto.randomUUID());
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  container.insert(0, [paragraph]);
  group.insert(group.length, [container]);
  return text;
}

export interface PageNode {
  id: string;
  kind: string;
}

/** A random page other than the current one; files and the current page are skipped. */
export function pickOtherPage(
  nodes: readonly PageNode[],
  currentPageId: string,
  random: () => number = Math.random
): string | null {
  const candidates = nodes.filter((node) => node.kind === 'page' && node.id !== currentPageId);
  if (candidates.length === 0) return null;
  const index = Math.max(0, Math.min(candidates.length - 1, Math.floor(random() * candidates.length)));
  return candidates[index]!.id;
}

/** The next navigation delay: the base interval plus up to `jitterMs` of spread. */
export function navigationDelay(
  navigateMs: number,
  jitterMs: number,
  random: () => number = Math.random
): number {
  return navigateMs + (jitterMs > 0 ? Math.floor(random() * jitterMs) : 0);
}

/**
 * One person in a browser tab, without the browser: a real collab token, a real Hocuspocus
 * connection, real Yjs transactions into a block's text, and an awareness ping so the round
 * trip is measured without writing authorship rows or triggering a state store.
 */
export class VirtualEditor {
  private doc: Y.Doc | null = null;
  private provider: HocuspocusProvider | null = null;
  private awareness: HocuspocusProvider['awareness'] = null;
  private socket: HocuspocusProviderWebsocket | null = null;
  private text: Y.XmlText | null = null;
  private timers: NodeJS.Timeout[] = [];
  private pingSeq = 0;
  private lastPing: { seq: number; t: number } | null = null;
  private pongs: Record<string, { epoch: string; seq: number; t: number }> = {};
  private answered = new Map<string, number>();
  private recorded = new Map<string, number>();
  /** Distinguishes this editor's pings after a reconnect, when the sequence restarts. */
  private readonly epoch = crypto.randomUUID();
  private stopped = false;
  private navigating = false;
  private edits = 0;
  private reads = 0;
  private navigations = 0;
  private errors = 0;
  private pageId: string;
  /** Ignore late pongs so a peer's navigation pause is not reported as network RTT. */
  private readonly pongTtlMs = 1000;
  readonly latency = new LatencyMeter();
  readonly readLatency = new LatencyMeter();
  private readonly id: string;

  constructor(private readonly options: EditorOptions) {
    this.pageId = options.pageId;
    this.id = `${options.user.user.id}:${options.pageId}`;
  }

  /** Connects, waits for the first sync, and prepares the text this editor will type into. */
  async connect(): Promise<void> {
    if (this.stopped) return;
    const pageId = this.pageId;
    const first = await this.collabToken(pageId);
    if (this.stopped) return;
    if (first.access !== 'write') {
      throw new Error(`editor ${this.options.user.user.email} has read-only access to page ${pageId}`);
    }

    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: this.options.collabUrl,
      WebSocketPolyfill: WebSocket,
      maxAttempts: 0,
    });
    let provider!: HocuspocusProvider;
    const synced = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the collab client to sync')), 15_000);
      provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: `${this.options.tenantId}:${pageId}`,
        document: doc,
        token: async () => (await this.collabToken(pageId)).token,
        onSynced: () => {
          clearTimeout(timer);
          resolve();
        },
        onAuthenticationFailed: ({ reason }: { reason: string }) => {
          clearTimeout(timer);
          const error = new Error(`collab authentication failed: ${reason}`);
          this.fail(error);
          reject(error);
        },
      });
      provider.attach();
    });

    try {
      await synced;
    } catch (error) {
      provider.destroy();
      socket.destroy();
      doc.destroy();
      throw error;
    }

    if (this.stopped) {
      provider.destroy();
      socket.destroy();
      doc.destroy();
      return;
    }

    const awareness = provider.awareness;
    if (!awareness) {
      provider.destroy();
      socket.destroy();
      doc.destroy();
      throw new Error('collab provider did not expose awareness');
    }

    this.doc = doc;
    this.provider = provider;
    this.awareness = awareness;
    this.socket = socket;
    this.text = ensureTextTarget(doc, this.options.index);
    awareness.setLocalStateField('loadPong', { id: this.id, pongs: this.pongs });
    awareness.on('change', this.onAwareness);
  }

  /** Starts typing, pinging, and the optional read and navigation loops. */
  start(): void {
    if (this.stopped || !this.doc) return;
    this.timers.push(setInterval(() => this.type(), this.options.typingMs));
    this.timers.push(setInterval(() => this.ping(), this.options.pingMs));
    if (this.options.readMs > 0) this.timers.push(setInterval(() => void this.read(), this.options.readMs));
    this.scheduleNavigation();
  }

  private scheduleNavigation(): void {
    if (this.stopped || this.options.navigateMs <= 0) return;
    const delay = navigationDelay(this.options.navigateMs, this.options.navigateJitterMs);
    const timer = setTimeout(() => {
      void this.navigate().finally(() => this.scheduleNavigation());
    }, delay);
    this.timers.push(timer);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.teardownConnection();
  }

  stats(): EditorStats {
    return {
      edits: this.edits,
      reads: this.reads,
      navigations: this.navigations,
      errors: this.errors,
      latency: this.latency.stats(),
      readLatency: this.readLatency.stats(),
    };
  }

  private teardownConnection(): void {
    this.awareness?.off('change', this.onAwareness);
    try {
      this.provider?.destroy();
    } catch {
      // Already gone.
    }
    try {
      this.socket?.destroy();
    } catch {
      // Already gone.
    }
    this.doc?.destroy();
    this.doc = null;
    this.provider = null;
    this.awareness = null;
    this.socket = null;
    this.text = null;
    // Pings from the old document must not be counted against the new connection.
    this.lastPing = null;
    this.pongs = {};
    this.answered.clear();
    this.recorded.clear();
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.user.token}`,
      'x-tenant-id': this.options.tenantId,
    };
  }

  private async collabToken(pageId: string): Promise<{ token: string; access: 'read' | 'write' }> {
    const res = await fetch(`${this.options.apiUrl}/api/v1/pages/${pageId}/collab-token`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`POST collab-token -> ${res.status} ${await res.text()}`);
    return (await res.json()) as { token: string; access: 'read' | 'write' };
  }

  /**
   * Awareness is ephemeral, so the latency probe never touches the page fragment and never
   * causes a `ydoc_state` store or an authorship row.
   */
  private readonly onAwareness = (): void => {
    const awareness = this.awareness;
    if (!awareness || this.stopped) return;
    const self = awareness.clientID;
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === self) continue;

      const ping = state.loadPing as { id?: string; epoch?: string; seq?: number; t?: number } | undefined;
      const answerKey = ping ? `${ping.id}:${ping.epoch}` : '';
      if (
        ping &&
        typeof ping.id === 'string' &&
        typeof ping.epoch === 'string' &&
        ping.id !== this.id &&
        typeof ping.seq === 'number' &&
        typeof ping.t === 'number' &&
        Date.now() - ping.t < 10_000 &&
        ping.seq > (this.answered.get(answerKey) ?? 0)
      ) {
        this.answered.set(answerKey, ping.seq);
        this.pongs[ping.id] = { epoch: ping.epoch, seq: ping.seq, t: ping.t };
        awareness.setLocalStateField('loadPong', { id: this.id, pongs: this.pongs });
      }

      const pong = state.loadPong as
        | { id?: string; pongs?: Record<string, { epoch: string; seq: number; t: number }> }
        | undefined;
      const mine = pong?.pongs?.[this.id];
      const recordKey = pong?.id && mine ? `${pong.id}:${mine.epoch}` : '';
      if (
        !mine ||
        !pong?.id ||
        !this.lastPing ||
        mine.seq !== this.lastPing.seq ||
        Date.now() - mine.t >= this.pongTtlMs ||
        (this.recorded.get(recordKey) ?? 0) >= mine.seq
      ) {
        continue;
      }
      this.recorded.set(recordKey, mine.seq);
      const rtt = Date.now() - mine.t;
      this.latency.add(rtt);
      this.options.onLatency?.(rtt);
    }
  };

  private type(): void {
    if (this.stopped || this.navigating || !this.text) return;
    const text = this.text;
    text.insert(text.length, CHARS[Math.floor(Math.random() * CHARS.length)]!);
    if (text.length > MAX_TEXT_LENGTH) text.delete(0, text.length - MAX_TEXT_LENGTH);
    this.edits += 1;
  }

  private ping(): void {
    if (this.stopped || !this.awareness) return;
    const seq = ++this.pingSeq;
    const t = Date.now();
    this.lastPing = { seq, t };
    this.awareness.setLocalStateField('loadPing', { id: this.id, epoch: this.epoch, seq, t });
  }

  /**
   * Fetches the page list, switches to a random other page, opens a fresh collab
   * connection, reads the page, and only then resumes typing.
   */
  private async navigate(): Promise<void> {
    if (this.stopped || this.navigating || this.options.navigateMs <= 0) return;
    this.navigating = true;
    try {
      const nodes = await this.fetchPageNodes();
      if (this.stopped) return;
      const next = pickOtherPage(nodes, this.pageId);
      if (!next) throw new Error(`no other page to open in space ${this.options.spaceId}`);

      this.teardownConnection();
      this.pageId = next;
      await this.connect();
      if (this.stopped || !this.doc) return;

      this.navigations += 1;
      await this.readPage(next);
      if (this.stopped) return;
      if (this.options.navReadMs > 0) await sleep(this.options.navReadMs);
    } catch (error) {
      this.fail(error);
    } finally {
      this.navigating = false;
    }
  }

  private async fetchPageNodes(): Promise<PageNode[]> {
    const started = Date.now();
    const res = await fetch(`${this.options.apiUrl}/api/v1/spaces/${this.options.spaceId}/tree`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`GET space tree -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { nodes?: unknown };
    this.recordRead(started);
    if (!Array.isArray(body.nodes)) return [];
    return body.nodes.flatMap((node) => {
      if (typeof node !== 'object' || node === null) return [];
      const { id, kind } = node as { id?: unknown; kind?: unknown };
      return typeof id === 'string' && typeof kind === 'string' ? [{ id, kind }] : [];
    });
  }

  private async read(): Promise<void> {
    if (this.navigating) return;
    try {
      await this.readPage(this.pageId);
    } catch (error) {
      this.fail(error);
    }
  }

  private async readPage(pageId: string): Promise<void> {
    const started = Date.now();
    // Match the web client: page chrome is metadata; live content arrives over the collab socket.
    const res = await fetch(`${this.options.apiUrl}/api/v1/pages/${pageId}?meta=1`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`GET page -> ${res.status} ${await res.text()}`);
    await res.arrayBuffer();
    this.recordRead(started);
  }

  private recordRead(started: number): void {
    this.reads += 1;
    const ms = Date.now() - started;
    this.readLatency.add(ms);
    this.options.onReadLatency?.(ms);
  }

  private fail(error: unknown): void {
    this.errors += 1;
    this.options.onError?.(error);
  }
}
