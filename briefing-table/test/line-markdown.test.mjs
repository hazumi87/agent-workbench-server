/* The pure Markdown helpers [line markdown]: hasMarkup (when a line takes the render path) and stripMarks (the plain places). node test/line-markdown.test.mjs */
import { hasMarkup, stripMarks } from '../web/markdown-plain.mjs';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  + ${m}`); } else { fail += 1; console.log(`  X ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m}${a === b ? '' : `  got ${JSON.stringify(a)}`}`);

console.log('[hasMarkup: the common line stays on the plain path]');
for (const t of ['hello there', 'ok, done. See you at 3.', '@studio can you look at this?', 'a - b', 'snake_case_name is fine', 'cost is 5 * 3 today', 'a and b', '', 'x']) {
  ok(!hasMarkup(t), `plain: ${JSON.stringify(t)}`);
}
console.log('[hasMarkup: markup goes to the renderer]');
for (const t of ['this is **bold**', 'some `code` here', '*em* text', '_em_ text', '~~gone~~', '# Title', '> quoted', '- one\n- two', '1. first', '```js\nx\n```', '[a](https://x.example)', '| a | b |\n|---|---|', '---', 'before\n\n## Heading\nafter']) {
  ok(hasMarkup(t), `markup: ${JSON.stringify(t).slice(0, 40)}`);
}
console.log('[stripMarks: the marks go, the words stay]');
eq(stripMarks('this is **bold** and *slanted* and `code`'), 'this is bold and slanted and code', 'inline marks');
eq(stripMarks('~~old~~ new'), 'old new', 'strikethrough');
eq(stripMarks('# Title\n\nbody'), 'Title\n\nbody', 'a heading mark');
eq(stripMarks('> a quoted line'), 'a quoted line', 'a quote mark');
eq(stripMarks('- one\n- two'), '• one\n• two', 'list markers become bullets');
eq(stripMarks('1. first\n2) second'), '• first\n• second', 'numbered markers become bullets');
eq(stripMarks('see [the docs](https://x.example/a) now'), 'see the docs now', 'a link keeps its text');
eq(stripMarks('![a cat](https://x.example/c.png) here'), 'a cat here', 'an image keeps its alt text');
eq(stripMarks('```js\nlet a = 1;\n```'), 'let a = 1;', 'fence lines go, the code stays');
eq(stripMarks('snake_case_name and 5 * 3 stay'), 'snake_case_name and 5 * 3 stay', 'intraword underscores and spaced stars are not marks');
eq(stripMarks('mail me @studio please'), 'mail me @studio please', 'a mention is untouched');
eq(stripMarks(' **x** ', { trim: false }), ' x ', 'trim:false keeps the edges (search snippets)');
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
