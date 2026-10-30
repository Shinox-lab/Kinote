// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FieldDef } from '@kinote/contracts';

const api = vi.hoisted(() => ({
  mentionable: vi.fn(async () => [
    { userId: 'u-1', name: 'Mei Lin' },
    { userId: 'u-2', name: 'Jonah Okafor' },
  ]),
  linkTargets: vi.fn(async () => []),
}));
vi.mock('../src/lib/api.js', () => ({ api }));

import { FieldEditor } from '../src/components/fields/FieldEditor.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = { id: 'f-1', name: 'Owner', type: 'person', options: {} } as unknown as FieldDef;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  api.mentionable.mockClear();
});

async function renderOwner(onChange = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(FieldEditor, {
        def: owner,
        value: undefined,
        names: { users: new Map(), pages: new Map() },
        pageId: 'p-1',
        onChange,
        onAddChoice: async () => null,
      }),
    );
  });
  return container.querySelector('input')!;
}

const list = () => container!.querySelector('[role="listbox"]');

describe('a person field', () => {
  test('shows no list of people, and asks for none, until its box has focus', async () => {
    await renderOwner();
    expect(list()).toBeNull();
    expect(api.mentionable).not.toHaveBeenCalled();
  });

  test('lists people while focused, and hides them when focus moves away', async () => {
    const input = await renderOwner();
    await act(async () => input.focus());
    expect(list()?.textContent).toContain('Mei Lin');
    await act(async () => input.blur());
    expect(list()).toBeNull();
  });

  test('picking someone from the list adds them', async () => {
    const onChange = vi.fn();
    const input = await renderOwner(onChange);
    await act(async () => input.focus());
    const mei = Array.from(list()!.querySelectorAll('button')).find((b) => b.textContent === 'Mei Lin')!;
    await act(async () => {
      mei.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      mei.click();
    });
    expect(onChange).toHaveBeenCalledWith(['u-1']);
  });
});
