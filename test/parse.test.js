// Parser tests. These need no dependencies: node --test test/parse.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitTurns, extractMath, parseExport, isShareLink, guessTitle, fileName, toMarkdown } from '../src/parse.js';

describe('splitTurns', () => {
  it('splits ChatGPT "You said / ChatGPT said" text', () => {
    const t = splitTurns('You said:\nHi there\n\nChatGPT said:\nHello!\n\nYou said:\nBye');
    assert.deepEqual(
      t.map((x) => [x.role, x.label, x.md]),
      [
        ['user', 'You', 'Hi there'],
        ['assistant', 'ChatGPT', 'Hello!'],
        ['user', 'You', 'Bye'],
      ],
    );
  });
  it('splits Markdown headings and inline "User:" labels', () => {
    assert.deepEqual(splitTurns('## You\n\nq\n\n---\n\n## Claude\n\na').map((x) => x.label), ['You', 'Claude']);
    assert.deepEqual(
      splitTurns('User: what is 2+2?\nAssistant: 4').map((x) => [x.role, x.md]),
      [
        ['user', 'what is 2+2?'],
        ['assistant', '4'],
      ],
    );
  });
  it('ignores markers inside code fences and keeps unlabelled text as one block', () => {
    const t = splitTurns('You said:\nshow me\n\nChatGPT said:\n```\nYou said:\n```\ndone');
    assert.equal(t.length, 2);
    assert.ok(t[1].md.includes('```\nYou said:\n```'));
    assert.deepEqual(splitTurns('Just some notes\nwith two lines'), [{ role: 'other', label: '', md: 'Just some notes\nwith two lines' }]);
    assert.deepEqual(splitTurns('   '), []);
  });
});

describe('extractMath', () => {
  it('finds TeX but not currency or code', () => {
    const r = extractMath('Cost is $5 and $10. Inline $x^2$ and \\(y\\). `$not$`\n\n```\n$$no$$\n```\n\n\\[a+b\\]\n$$c$$');
    assert.deepEqual(
      r.math.map((m) => [m.tex, m.display]),
      [
        ['x^2', false],
        ['y', false],
        ['a+b', true],
        ['c', true],
      ],
    );
    assert.ok(r.text.includes('`$not$`'));
    assert.ok(r.text.includes('$$no$$'));
    assert.ok(r.text.includes('Cost is $5 and $10.'));
  });
});

describe('official exports', () => {
  const chatgpt = [
    {
      title: 'Sorting help',
      create_time: 1759800000,
      current_node: 'c',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['s'] },
        s: { id: 's', message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] } }, parent: 'root', children: ['a'] },
        a: { id: 'a', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Sort [3,1,2]'] } }, parent: 's', children: ['x', 'b'] },
        x: { id: 'x', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['old branch'] } }, parent: 'a', children: [] },
        b: { id: 'b', message: { author: { role: 'assistant' }, content: { content_type: 'code', text: 'sorted([3,1,2])' } }, parent: 'a', children: ['c'] },
        c: { id: 'c', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['It is [1,2,3] citeturn0search1.'] } }, parent: 'b', children: [] },
      },
    },
  ];

  it('reads ChatGPT conversations.json along the current branch and drops citation markers', () => {
    const items = parseExport(JSON.stringify(chatgpt));
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Sorting help');
    assert.equal(items[0].source, 'ChatGPT');
    assert.equal(items[0].date, '2025-10-07');
    assert.deepEqual(
      items[0].turns.map((t) => [t.role, t.md]),
      [
        ['user', 'Sort [3,1,2]'],
        ['assistant', 'It is [1,2,3] .'],
      ],
    );
  });

  it('reads ChatGPT chat.html and Claude conversations.json', () => {
    const page = `<html><script>\nvar jsonData = ${JSON.stringify(chatgpt)};\n</script></html>`;
    assert.equal(parseExport(page)[0].title, 'Sorting help');
    const claude = [{ name: 'Poem', created_at: '2026-01-02T03:04:05Z', chat_messages: [{ sender: 'human', text: 'Write a haiku' }, { sender: 'assistant', text: '', content: [{ type: 'text', text: 'Leaves fall' }] }] }];
    const item = parseExport(JSON.stringify(claude))[0];
    assert.equal(item.title, 'Poem');
    assert.equal(item.source, 'Claude');
    assert.equal(item.date, '2026-01-02');
    assert.deepEqual(item.turns.map((t) => [t.label, t.md]), [
      ['You', 'Write a haiku'],
      ['Claude', 'Leaves fall'],
    ]);
  });

  it('returns null for other JSON or text', () => {
    assert.equal(parseExport('{"a":1}'), null);
    assert.equal(parseExport('hello'), null);
    assert.equal(parseExport('[1,2'), null);
  });
});

describe('helpers', () => {
  it('recognises share links (which the tool never fetches)', () => {
    assert.equal(isShareLink('https://chatgpt.com/share/68e1-abc'), true);
    assert.equal(isShareLink(' https://claude.ai/share/abc \n'), true);
    assert.equal(isShareLink('see https://chatgpt.com/share/x for details'), false);
    assert.equal(isShareLink('https://example.com/share/x'), false);
  });
  it('makes safe file names and short titles', () => {
    assert.equal(fileName('a/b: c?*'), 'a b c');
    assert.equal(fileName('  '), 'conversation');
    assert.equal(fileName('数学 笔记.'), '数学 笔记');
    assert.ok(guessTitle([{ role: 'user', md: '## ' + 'word '.repeat(30) }], 'ChatGPT').length <= 70);
    assert.equal(guessTitle([], 'Claude'), 'Claude conversation');
  });
  it('writes Markdown with or without labels', () => {
    const c = { title: 'T', turns: [{ role: 'user', label: 'You', md: 'q' }, { role: 'assistant', label: 'Claude', md: 'a' }] };
    assert.equal(toMarkdown(c), '# T\n\n## You\n\nq\n\n---\n\n## Claude\n\na\n');
    assert.equal(toMarkdown(c, { labels: false }), '# T\n\nq\n\n---\n\na\n');
  });
});
