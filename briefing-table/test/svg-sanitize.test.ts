/**
 * M6: the server-side SVG sanitizer (allow-list parser, no DOM). Each case is a known way past a regex-only sanitizer.
 */
const { sanitizeSvg } = await import('../src/engine/svg-sanitize.ts');
let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const s = (x: string): string | null => sanitizeSvg(x);
const wrap = (inner: string, attrs = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

console.log('[kept]');
const good = s(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0L10 10" fill="url(#g)" stroke="#000" stroke-width="1"/><text x="1" y="2">hi &amp; bye</text>'));
ok(good !== null && good.includes('<path d="M0 0L10 10"') && good.includes('linearGradient') && good.includes('viewBox="0 0 10 10"') && good.includes('hi &amp; bye'), 'a normal logo survives (paths, gradient with a local url(#g), viewBox, escaped text)');
ok(s(wrap('<g style="fill:#f00;stroke-width:2"><rect width="3" height="3"/></g>'))?.includes('style="fill:#f00;stroke-width:2"') === true, 'a plain style attribute survives');

console.log('\n[the regex-sanitizer bypasses]');
const bad = (x: string, label: string, notIn: string[]): void => {
  const r = s(x);
  ok(r === null || notIn.every((t) => !r.toLowerCase().includes(t)), label);
};
bad(wrap('<script>alert(1)</script><circle r="1"/>'), 'script element and its text are gone', ['script', 'alert']);
bad(wrap('<circle r="1" onload="alert(1)" onclick = "x()"/>'), 'on* attributes are gone (any spacing)', ['onload', 'onclick', 'alert']);
bad(wrap('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject>'), 'foreignObject and everything in it', ['foreignobject', 'onerror', 'body']);
bad(wrap('<a href="javascript:alert(1)"><circle r="1"/></a>'), 'an <a> with a javascript: link', ['javascript', '<a']);
bad(wrap('<use href="javascript:alert(1)"/><use xlink:href="data:image/svg+xml;base64,AAAA"/><use href="https://evil.example/x.svg#a"/>'), 'use with a non-local reference', ['javascript', 'data:', 'evil']);
ok(s(wrap('<use href="#g"/>'))?.includes('href="#g"') === true, 'use with a local #id is kept');
bad(wrap('<image href="https://evil.example/t.png"/>'), 'image elements (external loads)', ['image', 'evil']);
bad(wrap('<style>@import url(https://evil.example/x.css);</style><rect/>'), 'style elements', ['style', 'import', 'evil']);
bad(wrap('<rect style="fill:url(https://evil.example/x)"/>'), 'a style value with an external url()', ['evil', 'url(https']);
bad(wrap('<rect fill="url(javascript:alert(1))"/>'), 'a javascript url() in a presentation attribute', ['javascript']);
bad(wrap('<animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/>'), 'animate/set that rewrite href/on*', ['animate', 'set', 'javascript']);
bad(wrap('<rect width="1" onmouseover=alert(1)/>'), 'an UNQUOTED attribute value: refused', ['onmouseover']);
bad(wrap('<rect fill="&#106;avascript:alert(1)"/>'), 'an entity-obfuscated javascript: value', ['javascript']);

console.log('\n[refused]');
ok(s('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>') === null, 'DOCTYPE/ENTITY: refused');
ok(s('<svg><![CDATA[<script>alert(1)</script>]]></svg>') === null, 'CDATA: refused');
ok(s('<html><body>x</body></html>') === null && s('plain text') === null && s('') === null && s(5 as never) === null, 'not an svg: refused');
ok(s('<svg><g><path d="M0 0"/></svg>') === null, 'unbalanced markup: refused');
ok(s('<svg></svg><script>x</script>') === null, 'content after the root: refused');
ok(s(wrap('x'.repeat(2.5 * 1024 * 1024))) === null, 'over 2 MB: refused');
ok(s(wrap('<g>'.repeat(70) + '</g>'.repeat(70))) === null, 'nesting over 64: refused');
ok(s('<svg><path d="M0 0"/></svg>')?.startsWith('<svg') === true, 'a bare <svg> with no xmlns is fine');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
