// parse.js: the parts of the converter that need no DOM and no dependencies.
// Splitting pasted text into turns, finding math, reading official ChatGPT / Claude exports,
// titles, file names and Markdown output. MIT License, (c) binbuilds.

/** @typedef {'user' | 'assistant' | 'other'} Role */
/** @typedef {{ role: Role, label: string, md: string }} RawTurn */
/** @typedef {{ title: string, source: 'ChatGPT' | 'Claude', date: string, turns: RawTurn[] }} ExportItem */

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function tidy(md) {
  return md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
}

// ------------------------------------------------------------------ share links

const SHARE_RE = /^\s*https?:\/\/(?:www\.)?(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|g\.co|grok\.com|(?:www\.)?perplexity\.ai|copilot\.microsoft\.com)\/\S*\s*$/i;

/** A bare share/chat URL was pasted. The tool never fetches it: the chat sites' terms forbid automated extraction. */
export function isShareLink(text) {
  return SHARE_RE.test(text) && !/\n/.test(text.trim());
}

// ------------------------------------------------------------------ math

/** Find math outside code: $$…$$, \[…\], \(…\), $…$ (not currency). Replaced by PLMATH<n>X placeholders. */
export function extractMath(md) {
  const math = [];
  const out = [];
  // Split off fenced code blocks and inline code so we never touch them.
  const parts = md.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$|`[^`\n]+`)/m);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1) {
      out.push(p);
      continue;
    }
    out.push(
      p.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<!\s)\$(?![\w$])/g, (m, a, b, c, d) => {
        const display = a != null || b != null;
        const tex = (a ?? b ?? c ?? d).trim();
        if (!tex) return m;
        math.push({ tex, display });
        const ph = `PLMATH${math.length - 1}X`;
        return display ? `\n\n${ph}\n\n` : ph;
      }),
    );
  }
  return { text: out.join(''), math };
}

// ------------------------------------------------------------------ plain text / Markdown → turns

const USER_WORDS = new Set(['you', 'user', 'me', 'human', 'i']);
const NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', copilot: 'Copilot', assistant: 'Assistant', ai: 'AI', grok: 'Grok', perplexity: 'Perplexity' };
const WHO = '(you|user|me|human|i|chatgpt|claude|gemini|copilot|assistant|ai|grok|perplexity)';
export const RE_SAID = new RegExp(`^\\s*(?:#{1,6}\\s*)?${WHO}\\s+said\\s*:?\\s*$`, 'i');
const RE_LABEL = new RegExp(`^\\s*(?:#{1,6}\\s*${WHO}|\\*\\*${WHO}\\s*:?\\*\\*\\s*:?|${WHO}\\s*:)\\s*$`, 'i');
const RE_INLINE = new RegExp(`^\\s*(?:\\*\\*)?${WHO}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s+(\\S.*)$`, 'i');

function who(word) {
  const w = word.toLowerCase();
  if (USER_WORDS.has(w)) return { role: 'user', label: 'You' };
  return { role: 'assistant', label: NAMES[w] || 'Assistant' };
}

/** Split pasted text at role markers ("You said:", "ChatGPT said:", "## You", "User:" …). */
export function splitTurns(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tryMarkers = (allowInline) => {
    const ms = [];
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) return;
      let m = l.match(RE_SAID);
      if (m) return void ms.push({ line: i, ...who(m[1]), rest: '' });
      m = l.match(RE_LABEL);
      if (m) return void ms.push({ line: i, ...who(m[1] || m[2] || m[3]), rest: '' });
      if (allowInline && (m = l.match(RE_INLINE))) ms.push({ line: i, ...who(m[1]), rest: m[2] });
    });
    return ms;
  };
  const ok = (ms) => ms.length >= 2 && ms.some((m) => m.role === 'user') && ms.some((m) => m.role === 'assistant');
  let ms = tryMarkers(false);
  if (!ok(ms)) ms = tryMarkers(true);
  if (!ok(ms)) return text.trim() ? [{ role: 'other', label: '', md: text.trim() }] : [];
  const turns = [];
  const pre = lines.slice(0, ms[0].line).join('\n').trim();
  if (pre) turns.push({ role: 'other', label: '', md: pre });
  ms.forEach((m, k) => {
    const end = k + 1 < ms.length ? ms[k + 1].line : lines.length;
    const body = [m.rest, ...lines.slice(m.line + 1, end)].join('\n').replace(/^\s*\n|\n\s*$/g, '').replace(/\n-{3,}\s*$/, '').trim();
    if (body) turns.push({ role: m.role, label: m.label, md: body });
  });
  return turns;
}

// ------------------------------------------------------------------ official exports (ChatGPT / Claude)

// ChatGPT wraps citation markers in private-use characters (U+E200 … U+E201); drop them.
const stripCites = (s) => s.replace(/[^]*/g, '').replace(/[-]/g, '');
const isoDate = (v) => {
  const n = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : '';
};

function pushTurn(turns, role, label, md) {
  md = md.trim();
  if (!md) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.md += `\n\n${md}`;
  else turns.push({ role, label, md });
}

/** One ChatGPT conversation: walk from current_node up to the root, so only the visible branch is kept. */
function chatgptConv(c) {
  const map = c && c.mapping;
  if (!map || typeof map !== 'object') return null;
  const chain = [];
  let id = c.current_node || null;
  if (!id) id = Object.keys(map).find((k) => !(map[k] && map[k].children && map[k].children.length)) || null;
  const seen = new Set();
  while (id && map[id] && !seen.has(id)) {
    seen.add(id);
    chain.push(map[id]);
    id = map[id].parent;
  }
  chain.reverse();
  const turns = [];
  for (const n of chain) {
    const m = n && n.message;
    const role = m && m.author && m.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    const ct = m.content && m.content.content_type;
    if (ct !== 'text' && ct !== 'multimodal_text') continue;
    const parts = (m.content.parts || []).map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' ? '*[image]*' : '')).filter(Boolean);
    pushTurn(turns, role, role === 'user' ? 'You' : 'ChatGPT', stripCites(parts.join('\n\n')));
  }
  return { title: String(c.title || 'ChatGPT conversation'), source: 'ChatGPT', date: isoDate(c.create_time), turns };
}

function claudeConv(c) {
  if (!c || !Array.isArray(c.chat_messages)) return null;
  const turns = [];
  for (const m of c.chat_messages) {
    const role = m && m.sender === 'human' ? 'user' : m && m.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const fromContent = Array.isArray(m.content)
      ? m.content
          .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
          .map((x) => x.text)
          .join('\n\n')
      : '';
    pushTurn(turns, role, role === 'user' ? 'You' : 'Claude', fromContent || String(m.text || ''));
  }
  return { title: String(c.name || 'Claude conversation'), source: 'Claude', date: isoDate(c.created_at), turns };
}

/** conversations.json (ChatGPT or Claude export) or ChatGPT's chat.html. Returns null if it is not an export. */
export function parseExport(text) {
  let src = text.trim();
  if (!/^[[{]/.test(src)) {
    const m = src.match(/jsonData\s*=\s*(\[[\s\S]*?\]);?\s*(?:\n|<\/script>)/);
    if (!m) return null;
    src = m[1];
  }
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return null;
  }
  const list = Array.isArray(data) ? data : [data];
  const items = list.map((c) => chatgptConv(c) || claudeConv(c)).filter((x) => !!x && x.turns.length > 0);
  return items.length ? items : null;
}

// ------------------------------------------------------------------ titles, file names, Markdown

export function guessTitle(turns, source) {
  const first = turns.find((t) => t.role === 'user') || turns[0];
  const line = ((first && first.md) || '')
    .split('\n')
    .map((l) => l.replace(/[#>*_`[\]]/g, '').trim())
    .find((l) => l.length > 0);
  if (!line) return source ? `${source} conversation` : 'Conversation';
  return line.length > 70 ? `${line.slice(0, 67).replace(/\s+\S*$/, '')}…` : line;
}

/** Conversation → Markdown: "# Title", then "## You" / "## ChatGPT" sections separated by rules. */
export function toMarkdown(c, opts = {}) {
  const labels = opts.labels !== false;
  const body = c.turns.map((t) => (labels && t.label ? `## ${t.label}\n\n${t.md}` : t.md)).join('\n\n---\n\n');
  return tidy(`# ${c.title}\n\n${body}`);
}

/** File name without extension: safe on Windows and macOS, keeps non-Latin letters. */
export function fileName(title) {
  const s = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return s || 'conversation';
}
