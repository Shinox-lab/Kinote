import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { AttentionItem, AttentionReason, RecentItem, UpdateItem } from '@kinote/contracts';
import { useAttention, useRecent, useSpaces, useUpdates, useWorkspace } from '../lib/queries.js';
import { loadSession } from '../lib/session.js';
import { relativeTime, updateSentence } from '../lib/updates.js';
import { authorColor } from '../lib/wiki.js';
import { DropZone } from '../components/DropZone.js';
import { useUploads } from '../lib/useUploads.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { FileTypeTile } from '../components/FileTypeTile.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { PageIcon, SearchIcon } from '../components/icons.js';
import { isKnownIcon } from '../lib/emoji.js';
import { ErrorNote, Loading } from '../components/ui.js';

const UPDATES_FIRST = 6;
const ATTENTION_FIRST = 5;

const REASON: Record<AttentionReason, { label: string; tone: string }> = {
  failed: { label: 'Failed', tone: 'bg-danger-bg text-danger' },
  review: { label: 'Review', tone: 'bg-review-bg text-review-text' },
  unindexed: { label: 'Not indexed', tone: 'bg-warn-bg text-warn-text' },
};

/** One page or file that needs someone: what, where, its status as the page shows it, and since when. */
function AttentionRow({ item, now }: { item: AttentionItem; now: Date }) {
  const { tenant } = useWorkspace();
  const reason = REASON[item.reason];
  return (
    <li>
      <DocumentLink
        tenantSlug={tenant.slug}
        kind={item.document.kind}
        id={item.document.id}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 hover:bg-hover"
      >
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${reason.tone}`}>{reason.label}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {item.document.title || 'Untitled'}
          <span className="font-normal text-muted"> · {item.document.spaceName}</span>
        </span>
        <span className="text-xs text-muted">{item.badge}</span>
        <time dateTime={item.changedAt} className="shrink-0 text-xs text-muted">
          {relativeTime(item.changedAt, now)}
        </time>
      </DocumentLink>
    </li>
  );
}

/** Failed indexing, waiting reviews and unindexed edits across the spaces you can read; hidden when there are none. */
function AttentionSection({ now }: { now: Date }) {
  const attention = useAttention();
  const [all, setAll] = useState(false);
  const items = attention.data ?? [];
  if (items.length === 0) return attention.error ? <ErrorNote error={attention.error} /> : null;
  const shown = all ? items : items.slice(0, ATTENTION_FIRST);
  return (
    <section aria-labelledby="home-attention" className="flex flex-col gap-2">
      <h2 id="home-attention" className="text-xs font-medium uppercase tracking-wide text-muted">
        Needs attention <span className="font-normal normal-case tracking-normal">{items.length}</span>
      </h2>
      <ul className="flex flex-col rounded-lg border border-line bg-surface p-1">
        {shown.map((item) => (
          <AttentionRow key={item.document.id} item={item} now={now} />
        ))}
      </ul>
      {items.length > ATTENTION_FIRST && !all && (
        <button type="button" onClick={() => setAll(true)} className="self-start px-2 py-1 text-xs font-medium text-accent-text hover:underline">
          Show all {items.length}
        </button>
      )}
    </section>
  );
}
const UPDATES_MOST = 30;

function ago(iso: string, now: Date): string {
  const value = relativeTime(iso, now);
  return /^\d/.test(value) ? `${value} ago` : value;
}

function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One Continue card: the page's emoji (or the file's type) over its title, space and age. */
function ContinueCard({ item, now }: { item: RecentItem; now: Date }) {
  const { tenant } = useWorkspace();
  return (
    <DocumentLink
      tenantSlug={tenant.slug}
      kind={item.kind}
      id={item.id}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3 hover:bg-hover"
    >
      <span className="flex size-7 items-center justify-center text-[22px] leading-none">
        {item.kind === 'file' ? (
          <FileTypeTile name={item.title} size={20} />
        ) : isKnownIcon(item.icon) ? (
          <span aria-hidden="true">{item.icon}</span>
        ) : (
          <span className="text-muted" aria-hidden="true">
            <PageIcon />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
        <span className="block truncate text-xs text-muted">
          {item.spaceName} · {item.kind === 'file' ? 'uploaded' : 'edited'} {ago(item.at, now)}
        </span>
      </span>
    </DocumentLink>
  );
}

function UpdateRow({ item, selfId, now }: { item: UpdateItem; selfId: string | null; now: Date }) {
  const { tenant } = useWorkspace();
  const { who, what } = updateSentence(item, selfId);
  const color = authorColor(item.actor.id ?? item.actor.name);
  return (
    <li>
      <DocumentLink
        tenantSlug={tenant.slug}
        kind={item.document.kind}
        id={item.document.id}
        className="flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-hover"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{ backgroundColor: color.tint, color: color.accent }}
        >
          {item.actor.name.trim().slice(0, 1).toUpperCase() || '?'}
        </span>
        <span className="min-w-0 flex-1 text-sm leading-snug">
          <span className="font-semibold text-fg">{who}</span>{' '}
          <span className="text-muted">{what}</span>
          <span className="text-muted"> · {item.document.spaceName}</span>
        </span>
        <time dateTime={item.createdAt} className="shrink-0 pt-0.5 text-xs text-muted">
          {relativeTime(item.createdAt, now)}
        </time>
      </DocumentLink>
    </li>
  );
}

/** `/w/$tenantSlug`: a welcome, the caller's way back in, and what changed lately. */
export function WorkspaceHomePage() {
  const { tenant } = useWorkspace();
  const { data: spaces, error, isPending } = useSpaces();
  const user = loadSession()?.user;
  const { enqueue } = useUploads();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const now = new Date();
  const recent = useRecent(3);
  const updates = useUpdates(UPDATES_MOST);
  const selfId = loadSession()?.user.id ?? null;

  if (isPending) return <Loading what="home" />;
  if (error) return <ErrorNote error={error} />;

  const open = (spaces ?? []).filter((space) => space.archivedAt === null);
  const inbox = open.find((space) => space.kind === 'inbox' && space.myRole !== 'viewer');
  const first = user?.name.trim().split(/\s+/)[0];
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const items = updates.data ?? [];
  const shownUpdates = all ? items : items.slice(0, UPDATES_FIRST);
  const groups: { key: string; label: string; items: UpdateItem[] }[] = [];
  for (const item of shownUpdates) {
    const key = new Date(item.createdAt).toDateString();
    const group = groups[groups.length - 1];
    if (group?.key === key) group.items.push(item);
    else groups.push({ key, label: dayLabel(item.createdAt, now), items: [item] });
  }
  const recentItems = recent.data ?? [];

  const content = (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.02em] text-fg md:text-[27px]">
          Welcome back{first ? `, ${first}` : ''}
        </h1>
        <p className="text-[11.5px] text-muted">{date}</p>
      </header>

      <form
        role="search"
        className="relative w-full max-w-[820px]"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({
            to: '/w/$tenantSlug/search',
            params: { tenantSlug: tenant.slug },
            search: query.trim() === '' ? {} : { q: query.trim() },
          });
        }}
      >
        <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <SearchIcon />
        </span>
        <input
          type="search"
          aria-label="Search pages and files"
          placeholder="Search pages and files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-[46px] w-full rounded-lg border border-line bg-surface pl-10 pr-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </form>

      <AttentionSection now={now} />

      {recent.error && <ErrorNote error={recent.error} />}
      {recentItems.length > 0 && (
        <section aria-labelledby="home-continue" className="flex flex-col gap-2">
          <h2 id="home-continue" className="text-xs font-medium uppercase tracking-wide text-muted">
            Continue
          </h2>
          <ul aria-label="Continue" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {recentItems.map((item) => (
              <li key={item.id} className="min-w-0">
                <ContinueCard item={item} now={now} />
              </li>
            ))}
          </ul>
          <ErrorNote error={recent.error} />
        </section>
      )}

      <section aria-labelledby="home-updates" className="flex flex-col gap-2">
        <h2 id="home-updates" className="text-xs font-medium uppercase tracking-wide text-muted">
          Updates
        </h2>
        <p className="-mt-1 text-xs text-muted">Every version saved, indexed or sent for review, newest first.</p>
        {updates.isPending && <Loading what="updates" />}
        <ErrorNote error={updates.error} />
        {updates.data && items.length === 0 && <p className="text-sm text-muted">Nothing has changed yet.</p>}
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="flex flex-col gap-1">
            <h3 className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted">{group.label}</h3>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <UpdateRow key={item.versionId} item={item} selfId={selfId} now={now} />
              ))}
            </ul>
          </section>
        ))}
        {items.length > UPDATES_FIRST && !all && (
          <button
            type="button"
            onClick={() => setAll(true)}
            className="self-start px-2 py-1 text-xs font-medium text-accent-text hover:underline"
          >
            Show more
          </button>
        )}
      </section>
    </div>
  );

  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Home</span>} />
      <div className="mx-auto w-full max-w-[820px]">
        {inbox ? (
          <DropZone
            target="your Inbox"
            onFiles={(files) => enqueue(files, { spaceId: inbox.id, parentId: null })}
            buttonVariant="primary"
            align="end"
          >
            {content}
          </DropZone>
        ) : (
          content
        )}
      </div>
    </>
  );
}
