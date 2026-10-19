import { describe, expect, test } from 'vitest';
import type { TreeNode } from '@living-wiki/contracts';
import {
  authorColor,
  authorLabel,
  badgeTone,
  badgeSettles,
  buildTree,
  pagePoll,
  PAGE_POLL_MS,
  PAGE_POLL_MAX_MS,
  descendantIds,
  pageControls,
  type PageControlsInput,
} from '../src/lib/wiki.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function node(n: number, parent: number | null, title: string, position = 'a0', kind: TreeNode['kind'] = 'page'): TreeNode {
  return {
    id: id(n),
    parentId: parent === null ? null : id(parent),
    position,
    kind,
    title,
    slug: kind === 'page' ? title.toLowerCase() : null,
    attention: null,
  };
}

describe('buildTree', () => {
  test('nests children under their parent', () => {
    const tree = buildTree([node(1, null, 'Root'), node(2, 1, 'Child'), node(3, 2, 'Grandchild')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.title).toBe('Root');
    expect(tree[0].children[0].node.title).toBe('Child');
    expect(tree[0].children[0].children[0].node.title).toBe('Grandchild');
  });

  test('orders siblings by position, then title, then id', () => {
    const tree = buildTree([
      node(1, null, 'Zed', 'a0'),
      node(2, null, 'Beta', 'a1'),
      node(3, null, 'Alpha', 'a1'),
      node(5, null, 'Same', 'a2'),
      node(4, null, 'Same', 'a2'),
    ]);
    expect(tree.map((t) => t.node.id)).toEqual([id(1), id(3), id(2), id(4), id(5)]);
  });

  test('compares positions as plain strings (uppercase sorts before lowercase), not by locale', () => {
    const tree = buildTree([node(1, null, 'Lower', 'a0'), node(2, null, 'Upper', 'B0')]);
    expect(tree.map((t) => t.node.title)).toEqual(['Upper', 'Lower']);
  });

  test('a node whose parent is not in the list becomes a root', () => {
    const tree = buildTree([node(2, 9, 'Orphan'), node(1, null, 'Root')]);
    expect(tree.map((t) => t.node.title).sort()).toEqual(['Orphan', 'Root']);
  });

  test('keeps files in the tree and is empty for no nodes', () => {
    expect(buildTree([])).toEqual([]);
    const tree = buildTree([node(1, null, 'Doc', 'a0', 'file')]);
    expect(tree[0].node.kind).toBe('file');
  });
});

describe('descendantIds', () => {
  test('collects every level below a node, not the node itself', () => {
    const nodes = [node(1, null, 'A'), node(2, 1, 'B'), node(3, 2, 'C'), node(4, null, 'D')];
    expect([...descendantIds(nodes, id(1))].sort()).toEqual([id(2), id(3)]);
    expect(descendantIds(nodes, id(4)).size).toBe(0);
  });
});

describe('authorColor', () => {
  test('is stable for one author and differs between authors', () => {
    expect(authorColor(id(1))).toEqual(authorColor(id(1)));
    expect(authorColor(id(1)).accent).not.toBe(authorColor(id(2)).accent);
  });

  test('returns hsl strings for the accent and the tint', () => {
    const c = authorColor(id(7));
    expect(c.accent).toMatch(/^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/);
    expect(c.tint).toMatch(/^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/);
  });

  test('spreads many authors over the hue wheel', () => {
    const hues = new Set(Array.from({ length: 60 }, (_, n) => authorColor(`author-${n}`).accent.split(' ')[0]));
    expect(hues.size).toBeGreaterThan(30);
  });
});

describe('authorLabel', () => {
  const names = new Map([[id(1), 'Ada']]);

  test('uses the known name and marks agents', () => {
    expect(authorLabel({ type: 'user', id: id(1) }, names, null)).toEqual({ name: 'Ada', isAgent: false });
    expect(authorLabel({ type: 'agent', id: id(1) }, names, null)).toEqual({ name: 'Ada', isAgent: true });
  });

  test('the signed-in user is "You"', () => {
    expect(authorLabel({ type: 'user', id: id(2) }, names, id(2))).toEqual({ name: 'You', isAgent: false });
  });

  test('an unknown author gets a neutral name with a short id so two of them stay apart', () => {
    expect(authorLabel({ type: 'user', id: id(3) }, names, null).name).toBe('Collaborator 0003');
    expect(authorLabel({ type: 'agent', id: id(4) }, names, null)).toEqual({ name: 'Agent 0004', isAgent: true });
  });

  test('a block with no recorded author is unattributed', () => {
    expect(authorLabel(undefined, names, null)).toEqual({ name: 'Unknown author', isAgent: false });
  });
});

describe('badgeTone', () => {
  test('maps the server badge to a colour, never to a status of its own', () => {
    expect(badgeTone('Index failed')).toBe('danger');
    expect(badgeTone('Indexed · v3')).toBe('ok');
    expect(badgeTone('Withdrawn')).toBe('muted');
    expect(badgeTone('Not indexed · v2 rejected')).toBe('muted');
    expect(badgeTone('Indexing…')).toBe('pending');
    expect(badgeTone('Saved · indexing soon')).toBe('pending');
    expect(badgeTone('Something new from a later server')).toBe('pending');
  });
});

describe('badgeSettles', () => {
  test('is true for the badges the server moves on from by itself', () => {
    expect(badgeSettles('Indexing…')).toBe(true);
    expect(badgeSettles('Saved · indexing soon')).toBe(true);
  });

  test('is false for badges that wait for a person or are final', () => {
    expect(badgeSettles('Indexed · v3')).toBe(false);
    expect(badgeSettles('Index failed')).toBe(false);
    expect(badgeSettles('Withdrawn')).toBe(false);
    expect(badgeSettles('Saved · not indexed (awaiting approval)')).toBe(false);
    expect(badgeSettles('Not indexed · v2 rejected')).toBe(false);
  });
});

describe('pagePoll', () => {
  test('polls while the badge settles, and stops after PAGE_POLL_MAX_MS of continuous settling', () => {
    let state = pagePoll(null, 'Saved · indexing soon', 1_000);
    expect(state).toEqual({ since: 1_000, interval: PAGE_POLL_MS });
    state = pagePoll(state.since, 'Indexing…', 1_000 + PAGE_POLL_MAX_MS - 1);
    expect(state).toEqual({ since: 1_000, interval: PAGE_POLL_MS });
    state = pagePoll(state.since, 'Indexing…', 1_000 + PAGE_POLL_MAX_MS);
    expect(state).toEqual({ since: 1_000, interval: false });
    expect(PAGE_POLL_MAX_MS).toBe(120_000);
  });

  test('a settled badge stops polling and restarts the clock', () => {
    let state = pagePoll(1_000, 'Indexed · v2', 500_000);
    expect(state).toEqual({ since: null, interval: false });
    state = pagePoll(state.since, 'Indexing…', 600_000);
    expect(state).toEqual({ since: 600_000, interval: PAGE_POLL_MS });
  });

  test('no page yet: no polling', () => {
    expect(pagePoll(5, undefined, 10)).toEqual({ since: null, interval: false });
  });
});

describe('pageControls', () => {
  const base: PageControlsInput = { badge: 'Saved · indexing soon', role: 'editor', reviewRequired: false, archived: false };
  const controls = (over: Partial<PageControlsInput>) => pageControls({ ...base, ...over });

  test('the primary button is "Index now" without review and "Submit for review" with it', () => {
    expect(controls({ reviewRequired: false }).primary).toBe('Index now');
    expect(controls({ reviewRequired: true }).primary).toBe('Submit for review');
  });

  test('a viewer, or no role, gets nothing', () => {
    for (const role of ['viewer', null] as const) {
      expect(controls({ role, badge: 'Index failed' })).toEqual({
        primary: null,
        retry: false,
        restoreIndexed: false,
        move: false,
        withdraw: false,
        archive: false,
        restorePage: false,
        restoreVersion: false,
      });
    }
  });

  test('lifecycle items follow the role: move for editors, withdraw for reviewers, archive for admins', () => {
    expect(controls({ role: 'editor' })).toMatchObject({ move: true, withdraw: false, archive: false });
    expect(controls({ role: 'reviewer' })).toMatchObject({ move: true, withdraw: true, archive: false });
    expect(controls({ role: 'admin' })).toMatchObject({ move: true, withdraw: true, archive: true });
  });

  test('restoring a version needs an editor on a live page', () => {
    expect(controls({ role: 'editor' }).restoreVersion).toBe(true);
    expect(controls({ role: 'admin' }).restoreVersion).toBe(true);
    expect(controls({ role: 'viewer' }).restoreVersion).toBe(false);
    expect(controls({ role: null }).restoreVersion).toBe(false);
    expect(controls({ role: 'admin', archived: true }).restoreVersion).toBe(false);
  });

  test('Retry shows only for exactly "Index failed"', () => {
    expect(controls({ badge: 'Index failed' }).retry).toBe(true);
    expect(controls({ badge: 'Index failed (again)' }).retry).toBe(false);
    expect(controls({ badge: 'index failed' }).retry).toBe(false);
    expect(controls({ badge: 'Indexing…' }).retry).toBe(false);
    expect(controls({ badge: 'Index failed', role: 'viewer' }).retry).toBe(false);
  });

  test('Restore indexed version shows for badges that start "Not indexed ·"', () => {
    expect(controls({ badge: 'Not indexed · v4 rejected' }).restoreIndexed).toBe(true);
    expect(controls({ badge: 'Not indexed · v4 rejected', role: 'viewer' }).restoreIndexed).toBe(false);
    expect(controls({ badge: 'Saved · not indexed (awaiting approval)' }).restoreIndexed).toBe(false);
    expect(controls({ badge: 'Not indexed' }).restoreIndexed).toBe(false);
  });

  test('an archived page offers only restore, and only to an admin', () => {
    expect(controls({ archived: true, role: 'admin', badge: 'Index failed' })).toEqual({
      primary: null,
      retry: false,
      restoreIndexed: false,
      move: false,
      withdraw: false,
      archive: false,
      restorePage: true,
      restoreVersion: false,
    });
    expect(controls({ archived: true, role: 'reviewer' }).restorePage).toBe(false);
    expect(controls({ archived: false, role: 'admin' }).restorePage).toBe(false);
  });
});
