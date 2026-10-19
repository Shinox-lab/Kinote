import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { errorMessage } from '../../lib/api.js';
import { useUpdates, useWorkspace } from '../../lib/queries.js';
import { loadSession } from '../../lib/session.js';
import { loadUpdatesOpen, saveUpdatesOpen } from '../../lib/sidebar.js';
import { relativeTime, updateSentence } from '../../lib/updates.js';
import { ChevronDownIcon, ChevronRightIcon } from '../icons.js';
import { ROW } from './NavRow.js';

const FIRST = 8;
const MOST = 30;

/** The sidebar's "what changed lately": the newest versions of pages the person can read, each linking to its page. */
export function UpdatesSection() {
  const { tenant } = useWorkspace();
  const [open, setOpen] = useState(() => loadUpdatesOpen());
  const [all, setAll] = useState(false);
  const { data: items, error, isPending } = useUpdates(all ? MOST : FIRST);
  const selfId = loadSession()?.user.id ?? null;
  const now = new Date();

  function toggle() {
    setOpen((v) => {
      saveUpdatesOpen(!v);
      return !v;
    });
  }

  return (
    <section aria-labelledby="sidebar-updates">
      <h2 id="sidebar-updates" className="pb-1 pt-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex w-full items-center gap-1 px-2 text-xs font-medium uppercase tracking-wide text-muted hover:text-fg"
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          Updates
        </button>
      </h2>
      {open && (
        <div>
          {isPending && <p className="px-2 py-1 text-xs text-muted">Loading…</p>}
          {error && (
            <p role="alert" className="px-2 py-1 text-xs text-danger">
              {errorMessage(error)}
            </p>
          )}
          {items && items.length === 0 && <p className="px-2 py-1 text-xs text-muted">Nothing yet</p>}
          {items && items.length > 0 && (
            <ul className="flex flex-col gap-px">
              {items.map((item) => {
                const { who, what } = updateSentence(item, selfId);
                return (
                  <li key={item.versionId}>
                    <Link
                      to="/w/$tenantSlug/p/$pageId"
                      params={{ tenantSlug: tenant.slug, pageId: item.document.id }}
                      className={`${ROW} items-start`}
                    >
                      <span className="min-w-0 flex-1 text-xs leading-snug">
                        <span className="font-medium">{who}</span>
                        {item.actor.type === 'agent' && (
                          <span className="ml-1 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-muted">
                            Agent
                          </span>
                        )}{' '}
                        <span className="text-muted">{what}</span>
                      </span>
                      <time dateTime={item.createdAt} className="shrink-0 pt-px text-xs text-muted">
                        {relativeTime(item.createdAt, now)}
                      </time>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {items && items.length >= FIRST && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="mt-1 px-2 text-xs text-accent-text hover:underline"
            >
              {all ? 'Show fewer' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
