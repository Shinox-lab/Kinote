// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CollectionRow, FieldDef } from '@kinote/contracts';

vi.mock('../src/lib/api.js', () => ({ api: { mentionable: vi.fn(async () => []), linkTargets: vi.fn(async () => []) } }));

import { Cell } from '../src/components/views/TableView.js';
import type { LayoutProps } from '../src/components/views/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = {
  id: 'f-status',
  name: 'Status',
  type: 'select',
  options: { choices: [{ id: 'planned', name: 'Planned', color: 'gray' }, { id: 'blocked', name: 'Blocked', color: 'red' }] },
} as unknown as FieldDef;
const done = { id: 'f-done', name: 'Done', type: 'checkbox', options: {} } as unknown as FieldDef;
const row = { id: 'r-1', title: 'Checkout', icon: null, values: { 'f-status': 'planned', 'f-done': false } } as unknown as CollectionRow;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function renderCell(def: FieldDef, canEdit = true) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const p = { canEdit, names: { users: new Map(), pages: new Map() }, setValue: vi.fn(), addChoice: vi.fn() } as unknown as LayoutProps;
  await act(async () => root!.render(createElement('table', null, createElement('tbody', null, createElement('tr', null, createElement('td', null, createElement(Cell, { row, def, p })))))));
  return p;
}

const editorShown = () => container!.querySelector('input, select, [role="group"]') !== null;

describe('a table cell', () => {
  test('shows just the value until it is clicked', async () => {
    await renderCell(status);
    expect(container!.textContent).toBe('Planned');
    expect(editorShown()).toBe(false);
  });

  test('a click opens the editor; moving focus out of the cell closes it', async () => {
    await renderCell(status);
    const value = container!.querySelector('button')!;
    await act(async () => value.click());
    expect(editorShown()).toBe(true);
    expect(container!.textContent).toContain('Blocked');

    const outside = document.createElement('button');
    document.body.append(outside);
    await act(async () => outside.focus());
    expect(editorShown()).toBe(false);
    outside.remove();
  });

  test('a checkbox stays a checkbox you can tick straight away', async () => {
    await renderCell(done);
    expect(container!.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  test('a reader sees the value and no way to edit it', async () => {
    await renderCell(status, false);
    expect(container!.textContent).toBe('Planned');
    expect(container!.querySelector('button')).toBeNull();
  });
});
