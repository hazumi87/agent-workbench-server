// [live preview] source slices: the phone Room settings "Live preview" toggle.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const room = rd('room.js');
const css = rd('room.css');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/look\.art\.querySelector\('h4'\)\?\.after\(livePreviewRow\(\)\)/.test(room), 'the toggle is the first thing in the Art section');
ok(/const LIVE_PV_KEY = 'hwb\.room\.livePreview'/.test(room) && /try \{\s*return localStorage\.getItem\(LIVE_PV_KEY\) === '1'/.test(room) && /try \{\s*localStorage\.setItem\(LIVE_PV_KEY/.test(room), 'remembered per person in localStorage, both reads and writes guarded');
ok(/preview\?\.current\(\)\?\.owner === 'settings' && liveWanted\(\)/.test(room) && /function paintGear\(\) \{\s*paintLivePreview\(\)/.test(room), 'applies only while Room settings is the open sheet; repainted on every preview change (close clears it)');
ok(!/livePreviewRow[\s\S]{0,400}\.focus\(/.test(room.slice(room.indexOf('function livePreviewRow'), room.indexOf('function paintGear'))), 'no programmatic focus');
const phone = css.slice(css.indexOf('/* ---- ROOM ON PHONE v1'));
ok(/\.rm-pv\.pv-live \{ inset: auto 0 0 0; height: 50%/.test(phone), 'phone: the sheet becomes a bottom half');
ok(/^\.pv-live-row \{ display: none; \}/m.test(css) && /\.pv-live-row \{ display: flex/.test(phone), 'the row exists only at <=600px');
ok(/\.pv-live-row input \{ width: 22px; height: 22px/.test(phone), 'touch-sized checkbox');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
