// render.js: turn a pasted conversation (HTML or text) into clean, sanitized HTML for printing,
// plus Markdown. Needs a DOMParser (the browser's, or jsdom's in tests). Makes no network requests.
// MIT License, (c) binbuilds.
import { Marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { esc, extractMath, splitTurns, guessTitle, tidy, RE_SAID } from './parse.js';

/** @typedef {import('./parse.js').Role} Role */
/** @typedef {{ role: Role, label: string, html: string, md: string }} Turn */
/** @typedef {{ title: string, source: string, turns: Turn[], pendingMath: boolean }} Conversation */
/** @typedef {(tex: string, display: boolean) => string | null} MathFn  TeX → MathML; null keeps the TeX as text. */

const BASE = 'https://chatgpt.com/';

// ------------------------------------------------------------------ sanitizer (allowlist)

const TAGS = new Set(
  (
    'p br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code span div strong b em i u s del ins sub sup mark small a img ' +
    'table thead tbody tfoot tr th td caption colgroup col figure figcaption details summary dl dt dd kbd samp var abbr cite q time section article header footer main ' +
    'math semantics mrow mi mn mo ms mtext mspace msup msub msubsup mfrac msqrt mroot mover munder munderover mtable mtr mtd mstyle mpadded mphantom menclose mmultiscripts mprescripts none annotation'
  ).split(' '),
);
const DROP_TAGS = new Set('script style link meta noscript template iframe object embed form button input textarea select option dialog svg canvas video audio source track base frame frameset annotation-xml'.split(' '));
const ATTRS = new Set(
  (
    'href src alt title colspan rowspan data-lang dir lang start reversed open datetime ' +
    'mathvariant display stretchy fence separator lspace rspace accent accentunder columnalign rowspacing columnspacing width height depth scriptlevel displaystyle encoding minsize maxsize movablelimits linethickness notation'
  ).split(' '),
);

function safeUrl(v, kind) {
  const s = v.trim();
  if (kind === 'src' && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    if (kind === 'href' && u.protocol === 'mailto:') return u.href;
  } catch {
    /* relative or junk */
  }
  return null;
}

function clean(node) {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      child.remove();
      continue;
    }
    clean(child);
    if (!TAGS.has(tag)) {
      // Unknown element (custom elements etc.): keep its content, drop the wrapper.
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const a of Array.from(child.attributes)) {
      const name = a.name.toLowerCase();
      if (!ATTRS.has(name)) {
        child.removeAttribute(a.name);
        continue;
      }
      if (name === 'href' || name === 'src') {
        const v = safeUrl(a.value, name);
        if (v) child.setAttribute(name, v);
        else child.removeAttribute(a.name);
      }
    }
    if (tag === 'a') {
      child.setAttribute('rel', 'noopener noreferrer');
      child.setAttribute('target', '_blank');
    }
    if (tag === 'img') {
      if (!child.getAttribute('src')) child.remove();
      else child.setAttribute('loading', 'eager');
    }
  }
}

/** Returns sanitized HTML: document markup only, no scripts, handlers or javascript: URLs. */
export function sanitizeHtml(html, parser) {
  const d = parser.parseFromString(`<!doctype html><body><div id="r">${html}</div>`, 'text/html');
  const root = d.getElementById('r');
  clean(root);
  const walker = d.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode && c.parentNode.removeChild(c));
  return root.innerHTML;
}

// ------------------------------------------------------------------ HTML → Markdown

const JUNK = ['script', 'style', 'noscript', 'template', 'button', 'svg:not(.katex svg)', 'form', 'textarea', 'select', 'input', '[aria-hidden="true"]:not(.katex *)', '.sr-only'];

export function turndownService() {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.use(gfm);
  // KaTeX: emit the original TeX instead of the rendered glyphs.
  td.addRule('katex', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('katex'),
    replacement: (_c, n) => {
      const a = n.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (a && a.textContent && a.textContent.trim()) || n.textContent || '';
      return n.closest('.katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });
  td.addRule('katexDisplay', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('katex-display'),
    replacement: (_c, n) => {
      const a = n.querySelector('annotation[encoding="application/x-tex"]');
      return `\n\n$$\n${(a && a.textContent && a.textContent.trim()) || ''}\n$$\n\n`;
    },
  });
  // Code blocks: keep the language from "language-ts", "hljs python" or data-lang.
  td.addRule('fencedLang', {
    filter: (n) => n.nodeName === 'PRE',
    replacement: (_c, pre) => {
      const code = pre.querySelector('code') || pre;
      const cls = `${code.getAttribute('class') || ''} ${pre.getAttribute('class') || ''}`;
      const m = cls.match(/(?:language|lang)-([\w+#-]+)|brush:\s*([\w+#-]+)/);
      const lang = (m && (m[1] || m[2])) || pre.getAttribute('data-language') || pre.getAttribute('data-lang') || code.getAttribute('data-lang') || '';
      const body = (code.textContent || '').replace(/\n+$/, '');
      const fence = body.includes('```') ? '~~~' : '```';
      return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
    },
  });
  return td;
}

/** Clone an element for conversion: absolute URLs, no UI junk. */
export function cleanClone(el, base = BASE) {
  const clone = el.cloneNode(true);
  for (const sel of JUNK) {
    try {
      clone.querySelectorAll(sel).forEach((x) => x.remove());
    } catch {
      /* selector not supported by this DOM */
    }
  }
  clone.querySelectorAll('img[src]').forEach((img) => {
    try {
      img.setAttribute('src', new URL(img.getAttribute('src'), base).href);
    } catch {
      /* keep */
    }
  });
  clone.querySelectorAll('a[href]').forEach((a) => {
    const h = a.getAttribute('href');
    if (/^\s*javascript:/i.test(h)) a.removeAttribute('href');
    else
      try {
        a.setAttribute('href', new URL(h, base).href);
      } catch {
        /* keep */
      }
  });
  return clone;
}

// ------------------------------------------------------------------ chat page structure

function byRoleAttr(doc, sel, attr) {
  return Array.from(doc.querySelectorAll(sel))
    .map((el) => ({ role: el.getAttribute(attr) === 'user' ? 'user' : 'assistant', el }))
    .filter((t) => (t.el.textContent || '').trim().length > 0);
}

function inOrder(doc, userSel, botSel) {
  const users = new Set(doc.querySelectorAll(userSel));
  const all = Array.from(doc.querySelectorAll(`${userSel}, ${botSel}`));
  const top = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  return top.map((el) => ({ role: users.has(el) ? 'user' : 'assistant', el })).filter((t) => (t.el.textContent || '').trim().length > 0);
}

/** How to find the turns in HTML copied from each chat site. */
export const SITES = [
  { name: 'ChatGPT', turns: (doc) => byRoleAttr(doc, '[data-message-author-role]', 'data-message-author-role') },
  { name: 'Claude', turns: (doc) => inOrder(doc, '[data-testid="user-message"]', '.font-claude-response, [data-testid="assistant-message"], .font-claude-message') },
  { name: 'Gemini', turns: (doc) => inOrder(doc, 'user-query', 'model-response') },
];

// ------------------------------------------------------------------ Markdown → HTML (with math)

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code(t) {
      const lang = (t.lang || '').trim().split(/\s+/)[0];
      return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(t.text)}</code></pre>\n`;
    },
  },
});

export function renderMarkdown(md, parser, math) {
  const { text, math: found } = extractMath(md);
  let html = marked.parse(text, { async: false });
  let pending = false;
  html = html.replace(/(<p>)?PLMATH(\d+)X(<\/p>)?/g, (_m, open, n, close) => {
    const { tex, display } = found[Number(n)];
    let r = math ? math(tex, display) : null;
    if (r == null) {
      pending = true;
      r = display ? `<pre data-lang="math"><code>${esc(tex)}</code></pre>` : `<code>${esc(tex)}</code>`;
    }
    if (display) return r; // drop the wrapping <p>
    return `${open || ''}${r}${close || ''}`;
  });
  return { html: sanitizeHtml(html, parser), pendingMath: pending };
}

// ------------------------------------------------------------------ conversations

function finish(raw, parser, math, title, source) {
  let pendingMath = false;
  const turns = raw.map((t) => {
    const r = renderMarkdown(t.md, parser, math);
    pendingMath = pendingMath || r.pendingMath;
    return { role: t.role, label: t.label, html: r.html, md: t.md };
  });
  const assistant = raw.find((t) => t.role === 'assistant' && t.label !== 'Assistant');
  const src = source || (assistant && assistant.label) || '';
  return { title: title || guessTitle(turns, src), source: src, turns, pendingMath };
}

/** Pasted plain text or Markdown → conversation. */
export function fromText(text, parser, math) {
  return finish(splitTurns(text), parser, math);
}

/** One conversation from parseExport(). */
export function fromExport(item, parser, math) {
  return finish(item.turns, parser, math, item.title, item.source);
}

/** Pasted HTML (Ctrl+A, Ctrl+C on a chat or share page) → conversation. */
export function fromHtml(html, parser, math) {
  const doc = parser.parseFromString(html, 'text/html');
  // KaTeX: keep the MathML copy, drop the visual span soup (it would print twice once classes are stripped).
  doc.querySelectorAll('.katex-html, .sr-only, [data-testid="copy-turn-action-button"]').forEach((e) => e.remove());
  // Code language → data-lang (the sanitizer drops class names).
  doc.querySelectorAll('code[class*="language-"], pre[class*="language-"]').forEach((c) => {
    const m = (c.getAttribute('class') || '').match(/language-([\w+#-]+)/);
    const pre = c.closest('pre');
    if (m && pre && !pre.getAttribute('data-lang')) pre.setAttribute('data-lang', m[1]);
  });
  // ChatGPT puts a "python · Copy code" header inside <pre>; the language is shown from data-lang instead.
  doc.querySelectorAll('pre[data-lang]').forEach((pre) => {
    Array.from(pre.children).forEach((ch) => {
      if (!ch.querySelector('code') && ch.tagName !== 'CODE' && (ch.textContent || '').length < 60) ch.remove();
    });
  });
  const td = turndownService();
  for (const site of SITES) {
    const ts = site.turns(doc);
    if (ts.length && ts.some((t) => t.role === 'assistant')) {
      const turns = ts.map((t) => {
        const clone = cleanClone(t.el);
        return {
          role: t.role,
          label: t.role === 'user' ? 'You' : site.name,
          html: sanitizeHtml(clone.innerHTML, parser),
          md: tidy(td.turndown(clone)).trim(),
        };
      });
      return { title: guessTitle(turns, site.name), source: site.name, turns, pendingMath: false };
    }
  }
  // Unknown structure: if the text has role markers ("You said:" lives in screen-reader-only headings),
  // split the Markdown on them; otherwise keep it as one clean block.
  const marked2 = parser.parseFromString(html, 'text/html');
  marked2.querySelectorAll('.katex-html').forEach((e) => e.remove());
  marked2.querySelectorAll('.sr-only').forEach((e) => {
    const t = (e.textContent || '').trim();
    if (RE_SAID.test(t)) {
      const p = marked2.createElement('p');
      p.textContent = t;
      e.replaceWith(p);
    }
  });
  const split = splitTurns(tidy(td.turndown(cleanClone(marked2.body))));
  if (split.length > 1 && split.some((t) => t.role === 'user')) return finish(split, parser, math);
  const clone = cleanClone(doc.body);
  const md = tidy(td.turndown(clone)).trim();
  const turns = md ? [{ role: 'other', label: '', html: sanitizeHtml(clone.innerHTML, parser), md }] : [];
  return { title: guessTitle(turns, ''), source: '', turns, pendingMath: false };
}

/** The printable document (title + labelled turns). All turn HTML is already sanitized. */
export function docHtml(c, opts = {}) {
  const labels = opts.labels !== false;
  const meta = [c.source, opts.date || ''].filter(Boolean).map((s) => esc(s)).join(' · ');
  const head = `<header class="doc-head"><h2 class="doc-title">${esc(c.title)}</h2>${meta ? `<p class="doc-meta">${meta}</p>` : ''}</header>`;
  const turns = c.turns
    .map((t) => `<section class="turn ${t.role}">${labels && t.label ? `<div class="who">${esc(t.label)}</div>` : ''}<div class="body">${t.html}</div></section>`)
    .join('');
  return head + turns;
}
