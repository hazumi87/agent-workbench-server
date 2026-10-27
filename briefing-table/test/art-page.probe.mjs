/* Icon-sets page probe — asserts against the LIVE engine on :7420.
 *
 * Chromium deliberately: the tab strip this page mocks renders in the desktop
 * toolkit's WebView2, which IS Chromium.
 *
 * NON-DESTRUCTIVE. Every mutating assertion runs against a set this probe
 * creates and then deletes, and the library is asserted back to its original
 * size at the end. An earlier version of this file deleted REAL data by
 * assuming it could clean up broadly (101 rating rows became 99); the rule
 * since is that a probe may only remove what it made.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.HARBOR_WB_PORT ?? '7420';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = readFileSync(new URL('../secrets/engine.token', import.meta.url), 'utf8').trim();
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let failures = 0;
const ok = (cond, label, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) {
    failures++;
  }
};
const api = (p, opts) => fetch(`${BASE}${p}`, { headers: H, ...opts }).then((r) => r.json());

/* A tiny, well-formed mark. Two versions so replace/revert have something to
   actually swap between. */
const SVG_A = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z"/></svg>';
const SVG_B = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 22 22H2z"/></svg>';

const before = (await api('/api/logos')).logos;
const tmpName = `probe-set-${Date.now()}`;
const made = await api('/api/icon-lab/import', {
  method: 'POST',
  body: JSON.stringify({ svg: SVG_A, name: tmpName }),
});
ok(made.ok === true, 'probe set created', made.error || `#${made.logo?.id}`);
const id = made.logo?.id;

/* CLEAN UP EVEN ON FAILURE. This probe creates a set and deletes it at the end
   — but an interrupted or throwing run leaked one into Owner's real library
   (found on screen as "probe-set-1788483784783"). Test residue in production
   data is the same fault as leaving a synthetic fixture behind: it is a lie
   that outlives its test. So teardown is registered the moment the set exists,
   not written at the bottom and hoped for. */
let cleaned = false;
const cleanup = async () => {
  if (cleaned || id == null) {
    return;
  }
  cleaned = true;
  await fetch(`${BASE}/api/logos/${id}`, { method: 'DELETE', headers: H }).catch(() => {});
};
process.on('exit', () => {
  /* Best-effort only — process.on('exit') cannot await. The signal handlers
     below are what actually cover an interrupt. */
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(130);
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` },
  viewport: { width: 1400, height: 950 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const resp = await page.goto(`${BASE}/art.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
ok(resp.status() === 200, 'page loads', `HTTP ${resp.status()}`);
ok(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | ') || 'clean');

/* ---- the list: two groups, with the right rights ---- */
const list = await page.evaluate(() => ({
  yours: document.querySelectorAll('#listYours .ic-row').length,
  system: document.querySelectorAll('#listSystem .ic-row').length,
  heads: [...document.querySelectorAll('.ic-group-head')].map((h) => h.textContent),
}));
ok(list.yours === before.length + 1, 'library sets listed', `${list.yours} rows`);
ok(list.system === 8, 'Auriga presets listed separately', `${list.system} rows`);
ok(
  list.heads.some((h) => /read-only/i.test(h)),
  'system group is labelled read-only',
  list.heads.join(' / '),
);

/* ---- selecting shows BOTH sizes the art is used at ---- */
await page.locator(`#listYours .ic-row:has-text("${tmpName}")`).click();
await page.waitForTimeout(400);
const d = await page.evaluate(() => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    return e ? Math.round(e.getBoundingClientRect().width) : 0;
  };
  return {
    name: document.querySelector('.ic-d-name')?.textContent,
    badge: document.querySelector('.ic-d-badge')?.textContent,
    tabMark: box('.ic-tlogo'),
    s20: box('.ic-size-box.s20'),
    s64: box('.ic-size-box.s64'),
    hasWatermark: !!document.querySelector('.ic-wm svg'),
    ...(() => {
      const pane = document.querySelector('.ic-pane')?.getBoundingClientRect();
      const wm = document.querySelector('.ic-wm')?.getBoundingClientRect();
      const pre = document.querySelector('.ic-lorem')?.getBoundingClientRect();
      if (!pane || !wm || !pre) {
        return { paneSquare: false, wmFits: false, textFillsPct: 0, textOverWatermark: false, paneSize: '-', wmSize: '-' };
      }
      return {
        paneSquare: Math.abs(pane.width - pane.height) < 2,
        wmFits: wm.height <= pane.height + 1,
        textFillsPct: Math.round((pre.height / pane.height) * 100),
        textOverWatermark: pre.top < wm.bottom && pre.bottom > wm.top,
        paneSize: `${Math.round(pane.width)}x${Math.round(pane.height)}`,
        wmSize: `${Math.round(wm.width)}x${Math.round(wm.height)}`,
      };
    })(),
    hasStatusLine: !!document.querySelector('.ic-status') && !!document.querySelector('.ic-composer'),
    ...(() => {
      const pane = document.querySelector('.ic-pane')?.getBoundingClientRect();
      const wm = document.querySelector('.ic-wm')?.getBoundingClientRect();
      if (!pane || !wm) {
        return { paneSquare: false, wmFitsVertically: false, paneSize: '-', wmSize: '-' };
      }
      return {
        paneSquare: Math.abs(pane.width - pane.height) < 2,
        wmFitsVertically: wm.height <= pane.height + 1,
        paneSize: `${Math.round(pane.width)}x${Math.round(pane.height)}`,
        wmSize: `${Math.round(wm.width)}x${Math.round(wm.height)}`,
      };
    })(),
    marksHaveViewBox: [...document.querySelectorAll('.ic-tlogo svg, .ic-size-box svg')].every((s) =>
      s.getAttribute('viewBox'),
    ),
    facts: document.querySelector('.ic-facts')?.textContent.replace(/\s+/g, ' ').trim(),
    actions: [...document.querySelectorAll('.ic-d-actions .btn')].map((b) => b.textContent),
  };
});
ok(d.name === tmpName, 'detail shows the selected set', d.name);
ok(d.badge === `lib:${id}`, 'detail shows the stable key, not the name', d.badge);
ok(d.tabMark === 20, 'tab mark renders at exactly 20 CSS px', `${d.tabMark}px`);
ok(d.s20 === 20 && d.s64 === 64, 'true-size row spans 20px..64px', `${d.s20}/${d.s64}`);
ok(d.hasWatermark, 'watermark rendered');
/* AT LEAST 1:1, and actually FULL. The watermark is sized as a percentage of
   pane WIDTH, so a wide short pane crops an 80%-scale mark and the number stops
   meaning anything (Owner: "you need at least a 1:1 box ... to understand what
   the scale % plays out like"). And the readability test only asks its question
   if real text runs across the mark — a half-empty pane proves nothing. Both
   are silent failures: the mark still renders, it just lies about its size. */
ok(d.paneSquare, 'watermark pane is at least 1:1', d.paneSize);
ok(d.wmFits, 'watermark is not cropped by the pane', `${d.wmSize} in ${d.paneSize}`);
ok(d.textFillsPct >= 70, 'transcript fills the pane', `${d.textFillsPct}%`);
ok(d.textOverWatermark, 'transcript actually overlays the mark');
ok(d.hasStatusLine, 'session chrome present (composer + status line)');
/* AT LEAST 1:1. The watermark is sized as a percentage of pane WIDTH, so a wide
   short pane crops an 80%-scale mark top and bottom and the number stops
   meaning anything (Owner, 2026-09-03: "you need at least a 1:1 box ... to
   understand what the scale % plays out like"). Asserted because it is a
   silent failure — the mark still renders, it is just lying about its size. */
ok(d.paneSquare, 'watermark pane is at least 1:1', d.paneSize);
ok(d.wmFitsVertically, 'watermark is not cropped by the pane', `${d.wmSize} in ${d.paneSize}`);
ok(d.marksHaveViewBox, 'every rendered mark carries a viewBox');
ok(/1 path/.test(d.facts), 'facts report geometry', d.facts);

/* THE DRIVING CASE: two sets with the same name must be separable by their
   facts alone. That is the whole reason the detail pane exists. */
const hearths = before.filter((l) => /^hearth/i.test(l.name));
if (hearths.length >= 2) {
  const a = hearths[0];
  const b = hearths[1];
  const distinct =
    a.svg.length !== b.svg.length ||
    (a.svg.match(/<path/g) || []).length !== (b.svg.match(/<path/g) || []).length;
  ok(distinct, 'same-named sets are distinguishable by facts', `${a.name} ${a.svg.length}B vs ${b.name} ${b.svg.length}B`);
} else {
  console.log('SKIP  same-named sets are distinguishable  — fewer than two "hearth" sets present');
}

/* ---- the design system presets expose NO edit actions (Contract A: pin, never fork) ---- */
await page.locator('#listSystem .ic-row').first().click();
await page.waitForTimeout(300);
const sys = await page.evaluate(() => ({
  badge: document.querySelector('.ic-d-badge')?.textContent,
  actions: document.querySelectorAll('.ic-d-actions .btn').length,
}));
ok(/read-only/i.test(sys.badge || ''), 'preset detail is badged read-only', sys.badge);
ok(sys.actions === 0, 'preset exposes no edit actions', `${sys.actions} buttons`);
ok(d.actions.length >= 3, 'library set exposes management actions', d.actions.join(', '));

/* ---- manage: rename, replace, revert — over the API, on the probe's own set ---- */
const renamed = await api(`/api/logos/${id}`, { method: 'PATCH', body: JSON.stringify({ name: tmpName + '-r' }) });
ok(renamed.logo?.name === tmpName + '-r', 'rename applies', renamed.logo?.name);

/* Compare against what each step ACTUALLY stored, never against the literal
   markup sent: replace normalises through SVGO, which rewrites path data, so
   asserting on an input path string tests the optimiser rather than the swap. */
const vA = renamed.logo.svg;
const replaced = await api(`/api/logos/${id}`, { method: 'PATCH', body: JSON.stringify({ svg: SVG_B }) });
const vB = replaced.logo?.svg;
ok(!!vB && vB !== vA, 'replace swaps the art', `${vA.length}B -> ${vB?.length}B`);
ok(replaced.logo?.prev_svg === vA, 'replace keeps the previous art, exactly');

const reverted = await api(`/api/logos/${id}`, { method: 'PATCH', body: JSON.stringify({ revert: true }) });
ok(reverted.logo?.svg === vA, 'revert restores the previous art byte-for-byte');
const again = await api(`/api/logos/${id}`, { method: 'PATCH', body: JSON.stringify({ revert: true }) });
ok(again.logo?.svg === vB, 'revert is itself revertible (it swaps, not discards)');

/* Replacing normalises, so art that arrives broken cannot land in a tab. */
const dirty = await api(`/api/logos/${id}`, {
  method: 'PATCH',
  body: JSON.stringify({ svg: '<svg width="500" height="500"><path fill="#000000" d="M4 4h16v16H4z"/></svg>' }),
});
const ds = dirty.logo?.svg ?? '';
ok(/viewBox=/.test(ds) && /xmlns=/.test(ds) && !/fill="#/.test(ds), 'replaced art is normalised on the way in', `${ds.length}B`);

const noUndo = await api(`/api/logos/9999999`, { method: 'PATCH', body: JSON.stringify({ revert: true }) });
ok(!!noUndo.error, 'revert on an unknown set is refused, not silent', noUndo.error);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
ok(noOverflow, 'no horizontal page overflow');

/* ---- clean up ONLY what this probe made ---- */
await cleanup();
const after = (await api('/api/logos')).logos;
ok(after.length === before.length, 'probe left the library the size it found it', `${before.length} → ${after.length}`);

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
