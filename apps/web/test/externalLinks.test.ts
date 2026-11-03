// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { editorLinkOf, openEditorLink, openableHref } from '../src/components/editor/externalLinks.js';

afterEach(() => vi.restoreAllMocks());

describe('editor links', () => {
  test('only http, https and mailto links can be opened', () => {
    const base = 'https://wiki.example/w/acme/p/1';
    expect(openableHref('https://example.com/a', base)).toBe('https://example.com/a');
    expect(openableHref('mailto:a@example.com', base)).toBe('mailto:a@example.com');
    expect(openableHref('/w/acme/p/2', base)).toBe('https://wiki.example/w/acme/p/2');
    expect(openableHref('javascript:alert(1)', base)).toBeNull();
    expect(openableHref(' JavaScript:alert(1)', base)).toBeNull();
    expect(openableHref('data:text/html,<script>1</script>', base)).toBeNull();
    expect(openableHref('', base)).toBeNull();
  });

  test('a link opens in a new tab without an opener or referrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openEditorLink('https://example.com/a');
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
    openEditorLink('javascript:alert(1)');
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('finds the editor link around the clicked element, ignoring other anchors', () => {
    document.body.innerHTML =
      '<a data-inline-content-type="link" href="https://example.com"><b id="inside">x</b></a><a id="other" href="/x">y</a>';
    expect(editorLinkOf(document.getElementById('inside'))?.getAttribute('href')).toBe('https://example.com');
    expect(editorLinkOf(document.getElementById('other'))).toBeNull();
    expect(editorLinkOf(null)).toBeNull();
  });
});
