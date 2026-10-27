/* WINDOW-CHROME v34: light/dark decided PER TAB [window-chrome v34] Owner approved 2026-10-05.
 * Static harness over the real vendored bundle (web/assets/aurora/window-chrome) and palette.mjs;
 * mock data only, no engine, no pane. A PROBE (needs Playwright Chromium), not in npm test.
 * Run: node test/window-chrome-v34.probe.mjs   (screenshots to $V34_SHOTS if set) */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link href="/assets/aurora/window-chrome/tokens.css" rel="stylesheet">
<link href="/assets/aurora/window-chrome/hwb-chrome.css" rel="stylesheet">
<link href="/assets/aurora/window-chrome/hwb-ring.css" rel="stylesheet">
<link href="/light-mode.css" rel="stylesheet">
<style>body{margin:0;background:var(--ink);color:var(--text);font:14px var(--font)}#stage{height:300px;padding:12px}
.term{background:#14161b;color:#e6e6e6;height:100%;font:13px monospace;padding:10px;box-sizing:border-box}</style></head><body>
<div class="hwb is-tabbed" id="win" style="--base:#888"><div class="hwb-bar"><div class="hwb-lead"></div><div class="hwb-act"></div><div class="hwb-gutter"></div>
<div class="hwb-title"><span class="hwb-titletext"></span></div><div class="hwb-tabs"></div><div class="hwb-dead"></div></div>
<div class="hwb-seam"></div><div class="hwb-sbar" id="sbar"></div><div id="stage"><div class="term" id="term">$ claude  (a CLI tab stays dark inside)</div></div></div>
<script type="module">
import {hwbRenderTabs,hwbRenderSessionBar} from '/assets/aurora/window-chrome/hwb-chrome.js';
import {brandMarkPath} from '/aurora/brand-marks/aurora-brand-marks.js';
import * as P from '/palette.mjs';
const q=new URLSearchParams(location.search);
const shell=q.get('shell')||'dark', sel=q.get('sel')||'cli';
P.apply(document,P.tokens('aurora',null,shell),shell);
const room=id=>q.get(id)||undefined; // light|dark|undefined
const tabs=[
 {id:'cli',name:'Briefing Table',base:'oklch(.62 .15 258)',state:'idle',brand:'claude',logo:'',active:sel==='cli'},
 {id:'cli2',name:'HomeHub',base:'oklch(.62 .15 150)',state:'streaming',brand:'claude',logo:'',active:false},
 {id:'r1',kind:'workroom',name:'Room One',base:'oklch(.62 .15 322)',state:'idle',logo:'',active:sel==='r1',mode:room('r1')},
 {id:'r2',kind:'workroom',name:'Room Two',base:'oklch(.62 .15 55)',state:'waiting',logo:'',active:sel==='r2',mode:room('r2')},
];
hwbRenderTabs(document.getElementById('win'),{tabs,hubMark:'<svg viewBox="0 0 24 24"><rect x="2" y="2" width="8.5" height="8.5"/></svg>',liveCount:3,brandMarkPath});
const s=tabs.find(t=>t.id===sel);
hwbRenderSessionBar(document.getElementById('sbar'),{project:{name:s.name},title:'Session title for '+s.name,brand:'claude',brandMarkPath:brandMarkPath('claude'),messages:1,handoff:0,links:0,mode:s.mode});
if(s.id.startsWith('cli')) {} else document.getElementById('term').style.display='none';
window.ready=true;
</script></body></html>
`;
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/h34.html') { res.setHeader('content-type', 'text/html'); res.end(HARNESS); return; }
  const f = join(WEB, u.pathname);
  if (!f.startsWith(WEB) || !existsSync(f) || !statSync(f).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', TYPES[extname(f)] || 'application/octet-stream');
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) { failures += 1; } };
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1280, height: 420 } });
async function look(q, name) {
  await pg.goto(`${base}/h34.html?${q}`);
  await pg.waitForFunction(() => window.ready, null, { timeout: 5000 });
  await pg.waitForTimeout(300);
  if (process.env.V34_SHOTS) { await pg.screenshot({ path: join(process.env.V34_SHOTS, `v34-${name}.png`) }); }
  return pg.evaluate(() => {
    const o = { bar: document.getElementById('sbar').dataset.mode || null };
    document.querySelectorAll('.hwb-tab:not(.is-hub)').forEach((t) => { o[t.dataset.tab] = t.dataset.mode || null; });
    o.sbarText = getComputedStyle(document.getElementById('sbar').querySelector('.sb-title, .sb-project') || document.getElementById('sbar')).color;
    return o;
  });
}
let r = await look('shell=light&sel=r1', 'light-all');
ok(r.cli === null && r.r1 === null && r.r2 === null && r.bar === null, 'light shell, no overrides: every tab and the bar follow the shell');
r = await look('shell=light&sel=r2&r2=dark', 'light-r2dark');
ok(r.r2 === 'dark' && r.r1 === null && r.cli === null, 'light shell: only the dark-override room tab carries data-mode=dark');
ok(r.bar === 'dark', 'the session bar takes the SELECTED tab mode (dark)');
r = await look('shell=light&sel=r1&r2=dark', 'light-r2dark-selr1');
ok(r.bar === null, 'selecting a following tab puts the bar back on the shell mode');
r = await look('shell=dark&sel=r1&r1=light', 'dark-r1light');
ok(r.r1 === 'light' && r.bar === 'light' && r.r2 === null, 'dark shell: one room set to light, the bar follows it');
r = await look('shell=dark&sel=r1', 'dark-unchanged');
ok(r.cli === null && r.r1 === null && r.bar === null, 'dark shell, no overrides: unchanged');
r = await look('shell=light&sel=cli', 'light-cli');
ok(r.cli === null && r.bar === null, 'a CLI tab has no override and follows the light shell');
await b.close(); srv.close();
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
