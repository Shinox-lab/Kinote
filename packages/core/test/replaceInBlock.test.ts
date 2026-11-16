import { describe, expect, test } from 'vitest';
import type { BlockLike } from '@kinote/shared';
import { EDITABLE_BLOCK_TYPES, replaceInBlock } from '../src/edit/replaceInBlock.js';

const t = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text, styles });
const link = (href: string, ...content: unknown[]) => ({ type: 'link', href, content });
const para = (content: unknown[], children: BlockLike[] = []): BlockLike => ({
  id: 'b1',
  type: 'paragraph',
  props: { textAlignment: 'left' },
  content,
  children,
});
const ok = (r: ReturnType<typeof replaceInBlock>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.block;
};

describe('replaceInBlock', () => {
  test('replaces inside one run', () => {
    const block = ok(replaceInBlock(para([t('Launch is in November.')]), 'November', 'December'));
    expect(block.content).toEqual([t('Launch is in December.')]);
  });

  test('keeps links and bold outside the span', () => {
    const before = [t('See '), link('https://x', t('the plan')), t(' — due May'), t(' 3', { bold: true })];
    const block = ok(replaceInBlock(para(before), 'May', 'June'));
    expect(block.content).toEqual([t('See '), link('https://x', t('the plan')), t(' — due June'), t(' 3', { bold: true })]);
  });

  test('spans runs', () => {
    const block = ok(replaceInBlock(para([t('Launch '), t('in Nov', { bold: true })]), 'Launch in', 'Ship in'));
    expect(block.content).toEqual([t('Ship in'), t(' Nov', { bold: true })]);
  });

  test('inserted text takes the style of the run where old starts', () => {
    const block = ok(replaceInBlock(para([t('Due', { bold: true }), t(' May')]), 'Due May', 'Due June'));
    expect(block.content).toEqual([t('Due June', { bold: true })]);
  });

  test('words inside a link keep the href', () => {
    const block = ok(replaceInBlock(para([t('Read '), link('https://x', t('the old plan'))]), 'old plan', 'new plan'));
    expect(block.content).toEqual([t('Read '), link('https://x', t('the new plan'))]);
  });

  test('empty new deletes the words', () => {
    const block = ok(replaceInBlock(para([t('Launch is in late November.')]), 'late ', ''));
    expect(block.content).toEqual([t('Launch is in November.')]);
  });

  test('not found and ambiguous', () => {
    expect(replaceInBlock(para([t('a b a')]), 'zzz', 'x')).toEqual({ ok: false, reason: 'not_found', count: 0 });
    expect(replaceInBlock(para([t('a b a')]), 'a', 'x')).toEqual({ ok: false, reason: 'ambiguous', count: 2 });
  });

  test('id, type, props and children are unchanged; children are not matched', () => {
    const child: BlockLike = { id: 'c1', type: 'paragraph', content: [t('November child')], children: [] };
    const before = para([t('Launch in November.')], [child]);
    const block = ok(replaceInBlock(before, 'November', 'December'));
    expect({ id: block.id, type: block.type, props: block.props, children: block.children }).toEqual({
      id: 'b1',
      type: 'paragraph',
      props: { textAlignment: 'left' },
      children: [child],
    });
    expect(replaceInBlock(para([t('x')], [child]), 'child', 'y')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('editable block types', () => {
    expect(EDITABLE_BLOCK_TYPES.has('paragraph')).toBe(true);
    expect(EDITABLE_BLOCK_TYPES.has('table')).toBe(false);
    expect(EDITABLE_BLOCK_TYPES.has('image')).toBe(false);
  });
});
