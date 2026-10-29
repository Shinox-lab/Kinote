import { describe, expect, test } from 'vitest';
import type { TreeNode } from '@kinote/contracts';
import { ancestorIds, attentionLabel, buildTree, canCreatePages, expandedFor } from '../src/lib/wiki.js';

function node(id: string, parentId: string | null, attention: TreeNode['attention'] = null): TreeNode {
  return { id, parentId, position: 'a0', kind: 'page', title: id, icon: null, slug: id, attention };
}

// root -> mid -> leaf, plus a second root with a child.
const nodes = [
  node('root', null),
  node('mid', 'root'),
  node('leaf', 'mid', 'review'),
  node('other', null, 'failed'),
  node('other-child', 'other'),
];

describe('attentionLabel', () => {
  test('names each dot in words', () => {
    expect(attentionLabel('failed')).toBe('Indexing failed');
    expect(attentionLabel('review')).toBe('Waiting for review');
    expect(attentionLabel('editing')).toBe('Edited just now');
  });
});

describe('ancestorIds', () => {
  test('lists the parents from the root down, not the node itself', () => {
    expect(ancestorIds(nodes, 'leaf')).toEqual(['root', 'mid']);
    expect(ancestorIds(nodes, 'mid')).toEqual(['root']);
  });

  test('is empty for a root page or an unknown id', () => {
    expect(ancestorIds(nodes, 'root')).toEqual([]);
    expect(ancestorIds(nodes, 'nope')).toEqual([]);
  });

  test('stops at a parent that is not in the list and does not loop on a cycle', () => {
    expect(ancestorIds([node('orphan', 'missing')], 'orphan')).toEqual([]);
    const cyclic = [node('a', 'b'), node('b', 'a')];
    expect(ancestorIds(cyclic, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('expandedFor', () => {
  test('keeps what the person opened and reveals the current page', () => {
    const open = expandedFor(nodes, 'leaf', new Set(['other']));
    expect(open).toEqual(new Set(['other', 'root', 'mid']));
  });

  test('returns the saved set untouched when there is no current page or it is unknown', () => {
    expect(expandedFor(nodes, undefined, new Set(['x']))).toEqual(new Set(['x']));
    expect(expandedFor(nodes, 'nope', new Set(['x']))).toEqual(new Set(['x']));
  });

  test('does not mutate its input', () => {
    const saved = new Set(['x']);
    expandedFor(nodes, 'leaf', saved);
    expect(saved).toEqual(new Set(['x']));
  });
});

describe('buildTree keeps attention', () => {
  test('each item carries its node with its dot', () => {
    const [first, second] = buildTree(nodes);
    expect(first!.node.id).toBe('other');
    expect(first!.node.attention).toBe('failed');
    expect(second!.children[0]!.children[0]!.node.attention).toBe('review');
  });
});

describe('canCreatePages', () => {
  test('is true for editor and above, false for viewer and unknown', () => {
    expect(canCreatePages('editor')).toBe(true);
    expect(canCreatePages('reviewer')).toBe(true);
    expect(canCreatePages('admin')).toBe(true);
    expect(canCreatePages('viewer')).toBe(false);
    expect(canCreatePages(undefined)).toBe(false);
  });
});
