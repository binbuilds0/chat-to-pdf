// Rendering tests: HTML/Markdown → sanitized document. Needs `npm install` (jsdom, marked, temml, turndown).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import temml from 'temml';
import { parseExport } from '../src/parse.js';
import { fromHtml, fromText, fromExport, renderMarkdown, docHtml, sanitizeHtml } from '../src/render.js';
import { toMarkdown } from '../src/parse.js';

const { window } = new JSDOM('<!doctype html><body></body>');
const parser = new window.DOMParser();
const math = (tex, display) => temml.renderToString(tex, { displayMode: display, throwOnError: false });

describe('renderMarkdown', () => {
  it('renders MathML when a renderer is given, TeX text otherwise', () => {
    const a = renderMarkdown('Area $\\pi r^2$\n\n$$\\frac{a}{b}$$', parser, math);
    assert.equal(a.pendingMath, false);
    assert.ok(a.html.includes('<math'));
    assert.ok(a.html.includes('<mfrac>'));
    const b = renderMarkdown('Area $\\pi r^2$', parser);
    assert.equal(b.pendingMath, true);
    assert.ok(b.html.includes('<code>\\pi r^2</code>'));
  });
  it('keeps tables and code blocks whole, with the language', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nif x < 1:\n    print("<b>")\n```';
    const { html } = renderMarkdown(md, parser);
    assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
    assert.ok(html.includes('<pre data-lang="python"><code>if x &lt; 1:\n    print("&lt;b&gt;")</code></pre>'));
  });
  it('strips scripts, event handlers and javascript: links', () => {
    const { html } = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>\n\n[y](javascript:alert(2)) [ok](https://example.com)', parser);
    assert.doesNotMatch(html, /<script|onerror|href="javascript:/i);
    assert.ok(html.includes('href="https://example.com/"'));
  });
});

describe('sanitizeHtml', () => {
  it('keeps document markup and drops everything else', () => {
    assert.equal(sanitizeHtml('<p style="color:red" onclick="x()">Hi <custom-el>there</custom-el><iframe src="https://e.com"></iframe></p><!-- c -->', parser), '<p>Hi there</p>');
  });
});

describe('fromHtml', () => {
  it('reads a pasted ChatGPT page turn by turn, keeping MathML and code', () => {
    const h = `<main><h5 class="sr-only">You said:</h5><div data-message-author-role="user"><div class="whitespace-pre-wrap">Area of a circle?</div></div>
      <h6 class="sr-only">ChatGPT said:</h6><div data-message-author-role="assistant"><div class="markdown"><p>It is <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\pi r^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">πr2</span></span>.</p>
      <pre><div>python<button>Copy code</button></div><code class="hljs language-python">def area(r):\n    return 3.14 * r * r\n</code></pre>
      <table><thead><tr><th>r</th><th>area</th></tr></thead><tbody><tr><td>1</td><td>3.14</td></tr></tbody></table></div></div></main>`;
    const c = fromHtml(h, parser);
    assert.equal(c.source, 'ChatGPT');
    assert.deepEqual(
      c.turns.map((t) => [t.role, t.label]),
      [
        ['user', 'You'],
        ['assistant', 'ChatGPT'],
      ],
    );
    const a = c.turns[1];
    assert.ok(a.html.includes('<msup>'));
    assert.ok(!a.html.includes('πr2'));
    assert.ok(!a.html.includes('Copy code'));
    assert.ok(a.html.includes('<pre data-lang="python">'));
    assert.ok(a.md.includes('$\\pi r^2$'));
    assert.ok(a.md.includes('```python\ndef area(r):'));
    assert.match(a.md, /\| r \| area \|/);
    assert.equal(c.title, 'Area of a circle?');
  });
  it('reads a pasted Claude conversation', () => {
    const c = fromHtml('<div data-testid="user-message"><p>Hello Claude</p></div><div class="font-claude-response"><p>Hi! <strong>Welcome</strong>.</p></div>', parser);
    assert.equal(c.source, 'Claude');
    assert.ok(c.turns[1].html.includes('<strong>Welcome</strong>'));
  });
  it('falls back to screen-reader labels, then to one clean block', () => {
    const c = fromHtml('<h5 class="sr-only">You said:</h5><p>q1</p><h6 class="sr-only">ChatGPT said:</h6><p>a1</p>', parser);
    assert.deepEqual(c.turns.map((t) => t.label), ['You', 'ChatGPT']);
    const d = fromHtml('<p onclick="x()">Just <b>text</b></p><script>bad()</script>', parser);
    assert.equal(d.turns.length, 1);
    assert.equal(d.turns[0].role, 'other');
    assert.equal(d.turns[0].html, '<p>Just <b>text</b></p>');
  });
});

describe('documents', () => {
  it('turns an export item into a document and Markdown', () => {
    const claude = [{ name: 'Poem', created_at: '2026-01-02T03:04:05Z', chat_messages: [{ sender: 'human', text: 'Write a haiku' }, { sender: 'assistant', content: [{ type: 'text', text: 'Leaves *fall*' }] }] }];
    const c = fromExport(parseExport(JSON.stringify(claude))[0], parser, math);
    assert.equal(c.title, 'Poem');
    assert.ok(c.turns[1].html.includes('<em>fall</em>'));
    assert.equal(toMarkdown(c), '# Poem\n\n## You\n\nWrite a haiku\n\n---\n\n## Claude\n\nLeaves *fall*\n');
  });
  it('builds an escaped, labelled document', () => {
    const c = fromText('You said:\nq <b>\n\nClaude said:\nanswer', parser);
    c.title = 'T <x>';
    const h = docHtml(c, { date: '2026-10-07' });
    assert.ok(h.includes('<h2 class="doc-title">T &lt;x&gt;</h2>'));
    assert.ok(h.includes('<p class="doc-meta">Claude · 2026-10-07</p>'));
    assert.ok(h.includes('<div class="who">You</div>'));
    assert.ok(!docHtml(c, { labels: false }).includes('class="who"'));
    assert.equal(toMarkdown(c, { labels: false }), '# T <x>\n\nq <b>\n\n---\n\nanswer\n');
  });
});
