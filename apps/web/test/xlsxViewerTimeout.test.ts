// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FileVersion } from '@living-wiki/contracts';

const state = vi.hoisted(() => ({ unmounted: false }));

const controller = {
  isLoading: true,
  sheets: [],
  setActiveSheetIndex: vi.fn(),
};

vi.mock('@extend-ai/react-xlsx', async () => {
  const React = await import('react');
  return {
    useXlsxViewerController: () => {
      React.useEffect(() => () => {
        state.unmounted = true;
      }, []);
      return controller;
    },
    XlsxViewer: () => React.createElement('div', { 'data-testid': 'extend-viewer' }),
  };
});

vi.mock('../src/viewers/DownloadCard.js', async () => {
  const React = await import('react');
  return {
    DownloadCard: ({ reason }: { reason: string }) => React.createElement('p', null, reason),
  };
});

vi.mock('../src/lib/useResolvedTheme.js', () => ({ useResolvedTheme: () => 'light' }));

import XlsxViewer from '../src/viewers/XlsxViewer.js';

const version = { id: 'version-1', fileName: 'Budget.xlsx' } as FileVersion;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  state.unmounted = false;
  controller.setActiveSheetIndex.mockClear();
});

describe('XlsxViewer timeout', () => {
  test('unmounts the controller when the workbook takes too long', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(XlsxViewer, { bytes: new ArrayBuffer(1), version, page: 1 }));
    });
    expect(container.querySelector('[data-testid="extend-viewer"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    expect(container.textContent).toContain('This workbook took too long to preview.');
    expect(state.unmounted).toBe(true);
  });
});
