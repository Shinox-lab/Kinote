import { useParams } from '@tanstack/react-router';
import { openHistory } from '../../lib/pageUi.js';
import { usePageView } from '../../lib/usePageView.js';
import { ChangesList } from '../ChangesList.js';
import { PageActions } from '../PageActions.js';
import { Button } from '../ui.js';

/** The sidebar's section for the page being read: its actions, history and what changed. Nothing off a page. */
export function OnThisPage() {
  const { pageId } = useParams({ strict: false });
  if (pageId === undefined) return null;
  return <OnThisPageFor pageId={pageId} />;
}

function OnThisPageFor({ pageId }: { pageId: string }) {
  const { page, controls, changed } = usePageView(pageId);
  if (!page || !controls) return null;
  return (
    <section aria-labelledby="sidebar-on-this-page" className="flex max-h-[45%] min-h-0 flex-col gap-2 border-t border-line px-1 pt-2">
      <h2 id="sidebar-on-this-page" className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
        On this page
      </h2>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-1 pb-1">
        <PageActions page={page} controls={controls} onChanged={changed} stacked />
        <Button variant="secondary" aria-haspopup="dialog" onClick={() => openHistory(pageId)}>
          History
        </Button>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-fg">Changes</h3>
          <ChangesList pageId={pageId} />
        </div>
      </div>
    </section>
  );
}
