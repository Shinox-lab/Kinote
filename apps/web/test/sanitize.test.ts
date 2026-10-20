// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { HTML_LIMIT_CHARS, markdownToHtml, sanitizeHtml } from '../src/viewers/sanitize.js';

// Uploaded content is hostile until proven otherwise. These inputs are the usual ways text turns into
// running code; each output is checked as a string and as the DOM a browser would build from it.

const dom = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('sanitizeHtml: what is removed', () => {
  test('scripts go, with their content', () => {
    const out = sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });

  test('event handlers and images go', () => {
    expect(sanitizeHtml('<img src=x onerror=alert(1)>text')).toBe('text');
    expect(sanitizeHtml('<p onclick="x()" onmouseover=y()>hi</p>')).toBe('<p>hi</p>');
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toBe('');
  });

  test.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['java&#x73;cript:alert(1)'],
    ['&#106;avascript:alert(1)'],
    [' \tjavascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:x'],
    ['/relative/path'],
    ['#fragment'],
  ])('a link to %s keeps its text and loses its address', (href) => {
    const body = dom(sanitizeHtml(`<a href="${href}">click</a>`));
    const a = body.querySelector('a');
    expect(body.textContent).toBe('click');
    expect(a?.hasAttribute('href') ?? false).toBe(false);
  });

  test('embedded content, forms and styles go', () => {
    expect(sanitizeHtml('<svg><script>alert(1)</script><circle/></svg>ok')).toBe('ok');
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>ok')).toBe('ok');
    expect(sanitizeHtml('<object data="x"></object><embed src="x">ok')).toBe('ok');
    expect(sanitizeHtml('<form action="https://evil.example"><input name=a><button>go</button></form>')).not.toMatch(/<(form|input|button)/);
    expect(sanitizeHtml('<style>@import url(https://evil.example/x.css)</style>ok')).toBe('ok');
    expect(sanitizeHtml('<div style="background:url(https://evil.example/x)">text</div>')).toBe('text');
    expect(sanitizeHtml('<meta http-equiv="refresh" content="0;url=https://evil.example">ok')).toBe('ok');
    expect(sanitizeHtml('<base href="https://evil.example/">ok')).toBe('ok');
  });

  test('class, id, style, src and srcset are removed even on allowed tags', () => {
    const out = sanitizeHtml('<p class="x" id="y" style="color:red" data-a="1" aria-label="z" src="q" srcset="r">t</p>');
    expect(out).toBe('<p>t</p>');
  });

  test('a title is kept only on a link', () => {
    expect(sanitizeHtml('<p title="t">a</p>')).toBe('<p>a</p>');
    expect(dom(sanitizeHtml('<a href="https://ok.example/" title="t">a</a>')).querySelector('a')?.getAttribute('title')).toBe('t');
  });

  test('broken and nested markup cannot rebuild a script', () => {
    const out = sanitizeHtml('<scr<script>ipt>alert(1)</scr</script>ipt>');
    expect(dom(out).querySelector('script')).toBeNull();
    expect(out).not.toMatch(/<script/i);
    const mxss = sanitizeHtml('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>');
    expect(dom(mxss).querySelector('img, style, script')).toBeNull();
  });
});

describe('sanitizeHtml: what is kept', () => {
  test('an https link keeps its address and gets safe attributes', () => {
    const out = sanitizeHtml('<a href="https://ok.example/a?b=1" class="x" onclick="y()">link</a>');
    const a = dom(out).querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://ok.example/a?b=1');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttributeNames().sort()).toEqual(['href', 'rel', 'target']);
  });

  test('http and mailto links stay', () => {
    expect(dom(sanitizeHtml('<a href="http://a.example/">a</a>')).querySelector('a')?.getAttribute('href')).toBe('http://a.example/');
    expect(dom(sanitizeHtml('<a href="mailto:a@b.example">a</a>')).querySelector('a')?.getAttribute('href')).toBe('mailto:a@b.example');
  });

  test('text structure survives: headings, lists, quotes, code, tables', () => {
    const html =
      '<h1>T</h1><p>a <em>b</em> <strong>c</strong></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote>' +
      '<pre><code>code</code></pre><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  test('markup shown as text stays text', () => {
    expect(sanitizeHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('a large document is cleaned in a reasonable time', () => {
    const big = '<p><b>x</b> <a href="javascript:x()">y</a></p>'.repeat(10_000);
    const started = Date.now();
    const out = sanitizeHtml(big);
    expect(out.length).toBeGreaterThan(100_000);
    expect(out).not.toMatch(/javascript:/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('markup past the size limit is refused, so a huge file cannot freeze the page', () => {
    expect(HTML_LIMIT_CHARS).toBe(2_000_000);
    expect(() => sanitizeHtml('x'.repeat(HTML_LIMIT_CHARS + 1))).toThrow(RangeError);
    expect(sanitizeHtml('x'.repeat(HTML_LIMIT_CHARS))).toHaveLength(HTML_LIMIT_CHARS);
  });
});

describe('markdownToHtml', () => {
  test('raw HTML in Markdown is shown as text; scripts, javascript links and images are inert', () => {
    const out = markdownToHtml('# T\n\n<script>x</script>\n\n[l](javascript:alert(1)) ![i](http://x/y.png)');
    const body = dom(out);
    expect(body.querySelector('script, img')).toBeNull();
    expect(out).not.toMatch(/javascript:/i);
    expect(body.querySelector('h1')?.textContent).toBe('T');
    expect(body.textContent).toContain('<script>x</script>');
    expect(body.textContent).toContain('l i');
  });

  test('a script in the same block as text stays text', () => {
    const out = markdownToHtml('<script>x</script> [l](javascript:alert(1))');
    expect(dom(out).querySelector('script, a')).toBeNull();
    expect(out).toContain('&lt;script&gt;');
  });

  test('inline raw HTML and event handlers are text too', () => {
    const body = dom(markdownToHtml('a <img src=x onerror=alert(1)> b <b onclick="z()">bold</b>'));
    expect(body.querySelector('img, b')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('ordinary Markdown becomes ordinary HTML', () => {
    const out = markdownToHtml('## Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`code` and [site](https://ok.example/)');
    const body = dom(out);
    expect(body.querySelector('h2')?.textContent).toBe('Title');
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.querySelector('table td')?.textContent).toBe('1');
    expect(body.querySelector('code')?.textContent).toBe('code');
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://ok.example/');
  });
});
