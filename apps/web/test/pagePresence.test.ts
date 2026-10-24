import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/lib/session.js', () => ({ loadSession: () => null }));

const { PagePresence } = await import('../src/components/PagePresence.js');

function render(state: 'connecting' | 'connected' | 'offline'): string {
  return renderToStaticMarkup(
    createElement(PagePresence, { live: null, state, onReconnect: () => {} })
  );
}

describe('PagePresence', () => {
  test('offline names the state and offers Reconnect', () => {
    const html = render('offline');
    expect(html).toContain('Presence: offline');
    expect(html).toContain('Offline');
    expect(html).toContain('Reconnect');
  });

  test('connected shows only the live dot', () => {
    const html = render('connected');
    expect(html).toContain('Presence: connected');
    expect(html).not.toContain('Reconnect');
  });
});
