/* PROBE (real Chromium, not in npm test): the browser sanitizer web/svg-sanitize.mjs against the attack corpus and a few real shapes. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const mod = readFileSync(join(here, '..', 'web', 'svg-sanitize.mjs'), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${d})` : ''}`); } };
const b = await chromium.launch();
try {
  const page = await b.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({ type: 'module', content: `${mod}\nwindow.__s = sanitizeSvgText; window.__ready = true;` });
  await page.waitForFunction('window.__ready === true');
  const run = (s) => page.evaluate((x) => window.__s(x), s);
  const bad = [
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe srcdoc="<script>alert(1)</script>"/></foreignObject><path d="M0 0"/></svg>', /foreignObject|iframe|srcdoc|script/i],
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>', /script|alert/i],
    ['onload', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0" onclick="x()"/></svg>', /onload|onclick|alert/i],
    ['javascript href', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a></svg>', /javascript|<a/i],
    ['use href data', '<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml;base64,AAAA"/></svg>', /data:/i],
    ['animate href', '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>', /javascript|animate/i],
    ['style url', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="fill:url(https://evil.example/x)"/></svg>', /evil/i],
    ['entity', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>', /./],
  ];
  for (const [name, svg, re] of bad) { const r = await run(svg); ok(!re.test(r) || r === '', `${name}: nothing active survives`, r); }
  const good = await run('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0L10 10" fill="url(#g)" stroke="#123"/><text x="1" y="2">hi</text></svg>');
  ok(/viewBox="0 0 10 10"/.test(good) && /<path d="M0 0L10 10"/.test(good) && /fill="url\(#g\)"/.test(good) && />hi</.test(good), 'a normal SVG keeps its geometry, local gradient and text', good);
  const bare = await run('<svg viewBox="0 0 4 4"><path d="M0 0L4 4"/></svg>');
  ok(/<path d="M0 0L4 4"/.test(bare), 'a bare <svg> without xmlns still works', bare);
  ok((await run('not svg')) === '' && (await run('')) === '' && (await run('<div/>')) === '', 'not an svg: empty');
  // execution check: inject the output into a page and make sure nothing runs
  await page.evaluate(() => { window.__hit = false; });
  const vec = await run(bad[0][1] + '');
  await page.evaluate((h) => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); }, vec);
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => window.__hit)) === false && (await page.evaluate(() => document.querySelector('div').querySelectorAll('iframe,script,foreignObject').length)) === 0, 'injected output creates no iframe/script');
} finally {
  await b.close();
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
