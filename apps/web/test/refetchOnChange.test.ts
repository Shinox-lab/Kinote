// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useRefetchWhenChanged } from '../src/lib/pageUi.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));

function Probe({ count, refetch }: { count: number | undefined; refetch: () => void }) {
  useRefetchWhenChanged(count, refetch);
  return null;
}

describe('useRefetchWhenChanged', () => {
  test('refetches when the polled count moves, in either direction, but not on first sight', async () => {
    const refetch = vi.fn();
    root = createRoot(document.createElement('div'));
    const show = (count: number | undefined) => act(async () => root!.render(createElement(Probe, { count, refetch })));
    await show(undefined); // still loading
    await show(0); // first answer: the page was fetched with it
    expect(refetch).not.toHaveBeenCalled();
    await show(0);
    expect(refetch).not.toHaveBeenCalled();
    await show(3); // someone typed
    expect(refetch).toHaveBeenCalledTimes(1);
    await show(0); // indexed by itself
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
