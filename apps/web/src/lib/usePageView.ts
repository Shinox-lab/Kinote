import { usePage, useRefresh, useSpaces } from './queries.js';
import { pageControls } from './wiki.js';

/**
 * Everything the page chrome needs about one page, from the queries the screen
 * and the sidebar share (so both show the same badge and controls): the page,
 * its space, whether it is archived, which controls the role allows, and the two
 * refreshers. `reload` asks for the page again; `changed` follows an action
 * (also the trees, the archived list, the Updates feed and the review queue).
 */
export function usePageView(pageId: string | undefined) {
  const refresh = useRefresh();
  const { data: page, error, isPending } = usePage(pageId);
  const { data: spaces = [] } = useSpaces();
  const space = page ? spaces.find((s) => s.id === page.spaceId) : undefined;
  const archived = page ? page.archivedAt !== null || (space?.archivedAt ?? null) !== null : false;
  const controls = page
    ? pageControls({
        badge: page.badge,
        role: space?.myRole ?? null,
        reviewRequired: space?.reviewRequired ?? false,
        archived,
      })
    : null;

  const reload = () => {
    if (pageId !== undefined) void refresh('page', pageId);
  };
  const changed = () => {
    reload();
    void refresh('tree');
    void refresh('archived');
    void refresh('updates');
    void refresh('reviews');
  };
  return { page, error, isPending, spaces, space, archived, controls, reload, changed };
}
