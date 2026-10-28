import { ThreadStore, ThreadStoreAuth, type CommentBody, type CommentData, type ThreadData } from '@blocknote/core/comments';
import type { CommentThread } from '@living-wiki/contracts';

/** The API calls the store makes (`api` in the console; a fake in tests). */
export interface ThreadApi {
  list(pageId: string): Promise<CommentThread[]>;
  create(pageId: string, req: { block_id: string | null; quote: string | null; body: CommentBody }): Promise<CommentThread>;
  reply(threadId: string, body: CommentBody): Promise<CommentThread>;
  update(commentId: string, body: CommentBody): Promise<CommentThread>;
  removeComment(commentId: string): Promise<void>;
  removeThread(threadId: string): Promise<void>;
  resolve(threadId: string): Promise<CommentThread>;
  unresolve(threadId: string): Promise<CommentThread>;
}

/**
 * Who may do what with comments, mirroring the API: people who may edit the
 * page start threads, reply and resolve; authors edit and delete their own
 * comments; a space admin may delete anyone's. No reactions.
 */
export class WikiThreadAuth extends ThreadStoreAuth {
  constructor(
    private readonly userId: string,
    private rights: { canEdit: boolean; moderates: boolean }
  ) {
    super();
  }
  /** Rights change in place (a token re-fetch, the space role loading), so the editor is not rebuilt. */
  setRights(rights: { canEdit: boolean; moderates: boolean }) {
    this.rights = rights;
  }
  canCreateThread() {
    return this.rights.canEdit;
  }
  canAddComment() {
    return this.rights.canEdit;
  }
  canUpdateComment(comment: CommentData) {
    return comment.userId === this.userId;
  }
  canDeleteComment(comment: CommentData) {
    return comment.userId === this.userId || this.rights.moderates;
  }
  canDeleteThread(thread: ThreadData) {
    return (thread.metadata as { createdBy?: string } | undefined)?.createdBy === this.userId || this.rights.moderates;
  }
  canResolveThread() {
    return this.rights.canEdit;
  }
  canUnresolveThread() {
    return this.rights.canEdit;
  }
  canAddReaction() {
    return false;
  }
  canDeleteReaction() {
    return false;
  }
}

function toThreadData(t: CommentThread): ThreadData {
  return {
    type: 'thread',
    id: t.id,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    resolved: t.resolved,
    resolvedUpdatedAt: t.resolvedAt ? new Date(t.resolvedAt) : undefined,
    resolvedBy: t.resolvedBy ?? undefined,
    metadata: { blockId: t.blockId, quote: t.quote, createdBy: t.createdBy },
    comments: t.comments.map(
      (c): CommentData =>
        c.deletedAt
          ? {
              type: 'comment',
              id: c.id,
              userId: c.authorId,
              createdAt: new Date(c.createdAt),
              updatedAt: new Date(c.updatedAt),
              reactions: [],
              metadata: {},
              deletedAt: new Date(c.deletedAt),
              body: undefined,
            }
          : {
              type: 'comment',
              id: c.id,
              userId: c.authorId,
              createdAt: new Date(c.createdAt),
              updatedAt: new Date(c.updatedAt),
              reactions: [],
              metadata: {},
              body: c.body,
            }
    ),
  };
}

/**
 * BlockNote's comments, kept in the API rather than the page document: the
 * page holds only the comment marks. The store reloads the page's threads on
 * `refresh` (after each change, on a timer and on focus) and tells BlockNote.
 * `where` says which block and text a new thread is started on.
 */
export class ApiThreadStore extends ThreadStore {
  private threads = new Map<string, ThreadData>();
  /** The last answer, to tell no one when it did not change. */
  private lastAnswer = '';
  /** True once the first refresh is over (answered or failed): before, the store knows no threads. */
  loaded = false;
  private names = new Map<string, string>();
  private listeners = new Set<(threads: Map<string, ThreadData>) => void>();

  constructor(
    private readonly pageId: string,
    private readonly api: ThreadApi,
    auth: WikiThreadAuth,
    private where: () => { blockId: string | null; quote: string | null }
  ) {
    super(auth);
  }

  /** Where new threads are started: set by the editor, which knows the selection. */
  setWhere(where: () => { blockId: string | null; quote: string | null }) {
    this.where = where;
  }

  /** The display name of a comment author this store has seen. */
  userName(userId: string): string | undefined {
    return this.names.get(userId);
  }

  private take(list: CommentThread[]) {
    for (const t of list) for (const c of t.comments) this.names.set(c.authorId, c.authorName);
    return list;
  }

  private put(t: CommentThread): ThreadData {
    this.take([t]);
    const data = toThreadData(t);
    this.threads = new Map(this.threads).set(t.id, data);
    this.emit();
    return data;
  }

  private emit() {
    for (const cb of this.listeners) cb(this.threads);
  }

  async refresh(): Promise<void> {
    let list: CommentThread[];
    try {
      list = this.take(await this.api.list(this.pageId));
    } catch (err) {
      if (!this.loaded) {
        // Subscribers learn the store is ready even when its first answer failed.
        this.loaded = true;
        this.threads = new Map(this.threads);
        this.emit();
      }
      throw err;
    }
    this.loaded = true;
    const answer = JSON.stringify(list);
    if (answer === this.lastAnswer) return;
    this.lastAnswer = answer;
    this.threads = new Map(list.map((t) => [t.id, toThreadData(t)]));
    this.emit();
  }

  addThreadToDocument = undefined;

  async createThread(options: { initialComment: { body: CommentBody } }): Promise<ThreadData> {
    const { blockId, quote } = this.where();
    return this.put(await this.api.create(this.pageId, { block_id: blockId, quote, body: options.initialComment.body }));
  }

  async addComment(options: { comment: { body: CommentBody }; threadId: string }): Promise<CommentData> {
    const data = this.put(await this.api.reply(options.threadId, options.comment.body));
    return data.comments.at(-1)!;
  }

  async updateComment(options: { comment: { body: CommentBody }; threadId: string; commentId: string }): Promise<void> {
    this.put(await this.api.update(options.commentId, options.comment.body));
  }

  async deleteComment(options: { threadId: string; commentId: string }): Promise<void> {
    await this.api.removeComment(options.commentId);
    await this.refresh();
  }

  async deleteThread(options: { threadId: string }): Promise<void> {
    await this.api.removeThread(options.threadId);
    const next = new Map(this.threads);
    next.delete(options.threadId);
    this.threads = next;
    this.emit();
  }

  async resolveThread(options: { threadId: string }): Promise<void> {
    this.put(await this.api.resolve(options.threadId));
  }

  async unresolveThread(options: { threadId: string }): Promise<void> {
    this.put(await this.api.unresolve(options.threadId));
  }

  async addReaction(): Promise<void> {
    throw new Error('Reactions are not available.');
  }

  async deleteReaction(): Promise<void> {
    throw new Error('Reactions are not available.');
  }

  getThread(threadId: string): ThreadData {
    const t = this.threads.get(threadId);
    if (!t) throw new Error('Thread not found');
    return t;
  }

  getThreads(): Map<string, ThreadData> {
    return this.threads;
  }

  subscribe(cb: (threads: Map<string, ThreadData>) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
