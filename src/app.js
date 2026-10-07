// app.js: page logic for index.html. Bundled to dist/chat-to-pdf.js by scripts/build.mjs.
// No network requests: the page's Content-Security-Policy sets connect-src 'none', and all
// conversion happens here. The PDF is made by the browser's own print engine.
// MIT License, (c) binbuilds.
import temml from 'temml';
import { parseExport, isShareLink, toMarkdown, fileName } from './parse.js';
import { fromHtml, fromText, fromExport, docHtml } from './render.js';

const $ = (id) => document.getElementById(id);
const input = $('ctp-input');
const fileIn = $('ctp-file');
const notice = $('ctp-notice');
const picker = $('ctp-picker');
const filter = $('ctp-filter');
const list = $('ctp-list');
const titleIn = $('ctp-title');
const paper = $('ctp-paper');
const labels = $('ctp-labels');
const images = $('ctp-images');
const pdfBtn = $('ctp-pdf');
const mdBtn = $('ctp-md');
const doc = $('ctp-doc');
const count = $('ctp-count');
const pageCss = document.createElement('style');
document.head.appendChild(pageCss);

const parser = new DOMParser();
const mathFn = (tex, display) => {
  try {
    return temml.renderToString(tex, { displayMode: display, throwOnError: false, annotate: false });
  } catch {
    return null;
  }
};

let html = null; // HTML from the last paste/drop, used until the text is edited by hand
let exportItems = null;
let conv = null;
let titleTouched = false;

function say(msg, kind = 'info') {
  notice.textContent = msg;
  notice.dataset.kind = kind;
  notice.hidden = !msg;
}

const EMPTY = '<div class="empty"><p><b>Your clean document appears here.</b></p><p>Paste a conversation on the left, or open a file. Nothing is uploaded.</p></div>';

function render() {
  if (!conv || !conv.turns.length) {
    doc.innerHTML = EMPTY;
    count.textContent = '';
    pdfBtn.disabled = mdBtn.disabled = true;
    return;
  }
  if (!titleTouched) titleIn.value = conv.title;
  const c = { ...conv, title: titleIn.value.trim() || conv.title };
  doc.innerHTML = docHtml(c, { labels: labels.checked });
  doc.classList.toggle('noimg', !images.checked);
  const n = conv.turns.filter((t) => t.role !== 'other').length;
  count.textContent = n ? `${n} message${n === 1 ? '' : 's'}${conv.source ? ` · ${conv.source}` : ''}` : 'One block of text (no You / assistant labels found)';
  pdfBtn.disabled = mdBtn.disabled = false;
}

function convert() {
  const text = input.value;
  conv = null;
  if (exportItems) {
    const it = exportItems[Number(list.value) || 0];
    if (it) conv = fromExport(it, parser, mathFn);
  } else {
    say('');
    if (html) conv = fromHtml(html, parser, mathFn);
    else if (isShareLink(text))
      say('Share links are not opened for you: the chat sites’ terms don’t allow automated copying. Open the link, press Ctrl+A (⌘A on Mac) then Ctrl+C, and paste here.', 'warn');
    else if (text.trim()) {
      const items = /^\s*[[{]/.test(text) ? parseExport(text) : null;
      if (items) return showExport(items);
      conv = fromText(text, parser, mathFn);
    }
  }
  render();
}

let timer = 0;
const later = () => {
  clearTimeout(timer);
  timer = window.setTimeout(convert, 200);
};

// ---------------------------------------------------------------- input

input.addEventListener('paste', (e) => {
  const h = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
  const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  exportItems = null;
  picker.hidden = true;
  titleTouched = false;
  if (h && /<(p|div|pre|table|li|h\d|code|math)\b/i.test(h)) {
    e.preventDefault();
    html = h;
    input.value = t || input.value;
    convert();
  } else html = null;
});
input.addEventListener('input', () => {
  html = null;
  exportItems = null;
  picker.hidden = true;
  later();
});

async function openFile(f) {
  html = null;
  exportItems = null;
  picker.hidden = true;
  titleTouched = false;
  if (f.size > 300 * 1024 * 1024) return say('That file is too large to open in the browser (over 300 MB).', 'warn');
  const text = await f.text();
  const items = /\.(json|html?)$/i.test(f.name) || /^\s*[[{]/.test(text) ? parseExport(text) : null;
  if (items) {
    input.value = '';
    return showExport(items, f.name);
  }
  if (/\.html?$/i.test(f.name)) {
    html = text;
    input.value = `(${f.name})`;
  } else input.value = text;
  convert();
}

function showExport(items, name = 'export') {
  exportItems = items.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  fillList('');
  picker.hidden = false;
  say(`${items.length} conversation${items.length === 1 ? '' : 's'} found in ${name}. Pick one below.`);
  filter.value = '';
  convert();
}

function fillList(q) {
  if (!exportItems) return;
  const ql = q.toLowerCase();
  list.innerHTML = '';
  exportItems.forEach((it, i) => {
    if (ql && !it.title.toLowerCase().includes(ql)) return;
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${it.date ? it.date + ' · ' : ''}${it.title}`;
    list.appendChild(o);
  });
  if (list.options.length) list.selectedIndex = 0;
}

filter.addEventListener('input', () => {
  fillList(filter.value);
  titleTouched = false;
  convert();
});
list.addEventListener('change', () => {
  titleTouched = false;
  convert();
});

fileIn.addEventListener('change', () => {
  const f = fileIn.files && fileIn.files[0];
  if (f) openFile(f);
  fileIn.value = '';
});
for (const ev of ['dragover', 'dragenter'])
  input.addEventListener(ev, (e) => {
    e.preventDefault();
    input.classList.add('drag');
  });
input.addEventListener('dragleave', () => input.classList.remove('drag'));
input.addEventListener('drop', (e) => {
  input.classList.remove('drag');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) {
    e.preventDefault();
    openFile(f);
  }
});

titleIn.addEventListener('input', () => {
  titleTouched = true;
  render();
});
labels.addEventListener('change', render);
images.addEventListener('change', render);

$('ctp-clear').addEventListener('click', () => {
  input.value = '';
  html = null;
  exportItems = null;
  picker.hidden = true;
  titleTouched = false;
  titleIn.value = '';
  say('');
  convert();
  input.focus();
});

const EXAMPLE = `You said:
Compare quicksort and merge sort in a table, show the merge step in Python, and give the average-case cost.

ChatGPT said:
Here is a side-by-side comparison:

| | Quicksort | Merge sort |
|---|---|---|
| Average time | $O(n \\log n)$ | $O(n \\log n)$ |
| Worst case | $O(n^2)$ | $O(n \\log n)$ |
| Extra memory | $O(\\log n)$ | $O(n)$ |
| Stable | No | Yes |

The merge step:

\`\`\`python
def merge(a, b):
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            out.append(a[i]); i += 1
        else:
            out.append(b[j]); j += 1
    return out + a[i:] + b[j:]
\`\`\`

Merge sort's running time follows the recurrence

$$
T(n) = 2\\,T\\!\\left(\\frac{n}{2}\\right) + O(n) \\quad\\Rightarrow\\quad T(n) = O(n \\log n)
$$

You said:
Thanks! Which one should I use for a linked list?

ChatGPT said:
**Merge sort.** It needs no random access, and on a linked list the merge step can relink nodes in place, so the extra memory drops to $O(1)$.`;

function loadExample() {
  input.value = EXAMPLE;
  html = null;
  exportItems = null;
  picker.hidden = true;
  titleTouched = false;
  convert();
}
$('ctp-example').addEventListener('click', loadExample);

// ---------------------------------------------------------------- output

const currentTitle = () => titleIn.value.trim() || (conv && conv.title) || 'Conversation';

pdfBtn.addEventListener('click', async () => {
  if (!conv) return;
  const size = paper.value === 'letter' ? 'letter' : paper.value === 'a4' ? 'A4' : '';
  pageCss.textContent = `@page{${size ? `size:${size};` : ''}margin:16mm 15mm 18mm}`;
  const old = document.title;
  document.title = fileName(currentTitle()); // Chrome uses the page title as the PDF file name
  const restore = () => {
    document.title = old;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  // Let images finish loading before the print snapshot.
  await Promise.all(Array.from(doc.querySelectorAll('img')).map((img) => (img.complete ? null : new Promise((r) => ((img.onload = img.onerror = r), setTimeout(r, 3000))))));
  window.print();
  setTimeout(restore, 1000);
});

mdBtn.addEventListener('click', () => {
  if (!conv) return;
  const md = toMarkdown({ ...conv, title: currentTitle() }, { labels: labels.checked });
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName(currentTitle())}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

render();
if (/[?&]example\b/.test(location.search)) loadExample();
