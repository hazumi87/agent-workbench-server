/* zoom guard (web/zoom-guard.mjs): detect, meta toggle restores the exact
 * original, never while a text field has focus or mid-pinch, fires on layer
 * close / frame focus return / visible.  Owner 2026-10-03, IMG_7709/7710.
 *   node test/zoom-guard.test.mjs
 * The module's one import is swapped for a stub, then it runs AS SHIPPED. */
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed += 1; console.log(`  ok   ${m}`); } else { failed += 1; console.log(` FAIL  ${m}${d !== undefined ? `  (${JSON.stringify(d)})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let src = readFileSync(new URL('../web/zoom-guard.mjs', import.meta.url), 'utf8');
src = src.replace("import { isTextField } from '/soft-keyboard.mjs';", 'const isTextField = (el) => !!el && el.field === true;');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

const ORIG = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
function world(scale) {
  const listeners = {};
  const meta = { c: ORIG, history: [], getAttribute() { return this.c; }, setAttribute(_, v) { this.c = v; this.history.push(v); } };
  const doc = { activeElement: { tagName: 'BODY' }, visibilityState: 'visible', querySelector: () => meta, addEventListener: (t, f) => { (listeners['d' + t] ||= []).push(f); } };
  const win = { visualViewport: { scale }, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  globalThis.window = win; globalThis.document = doc;
  const fire = (t, e = {}) => (listeners[t] || []).forEach((f) => f(e));
  return { meta, doc, win, fire, fireDoc: (t) => (listeners['d' + t] || []).forEach((f) => f({})) };
}
const WAIT = 350 + 300 + 100;

{
  const w = world(1.2); const seen = [];
  mod.installZoomGuard({ onReset: (r) => seen.push(r) });
  w.fire('room:overlay-closed');
  await sleep(400);
  ok(w.meta.c.endsWith(', maximum-scale=1') && w.meta.c.startsWith(ORIG), 'zoomed + overlay closed: momentary maximum-scale', w.meta.c);
  await sleep(WAIT - 400);
  ok(w.meta.c === ORIG, 'original meta restored byte for byte', w.meta.c);
  ok(seen.length === 1 && seen[0].zoomReset === 1.2 && seen[0].why === 'overlay-closed', 'reported {zoomReset}', seen);
}
{
  const w = world(1.0);
  mod.installZoomGuard();
  w.fire('room:overlay-closed'); await sleep(WAIT);
  ok(w.meta.history.length === 0, 'scale 1: meta never touched');
}
{
  const w = world(1.2);
  mod.installZoomGuard();
  w.doc.activeElement = { tagName: 'TEXTAREA', field: true };
  w.fire('room:overlay-closed'); await sleep(WAIT);
  ok(w.meta.history.length === 0, 'no reset while a room text field has focus');
}
{
  const w = world(1.2);
  mod.installZoomGuard();
  w.fire('touchstart', { touches: [1, 2] });
  w.fire('room:overlay-closed'); await sleep(WAIT);
  ok(w.meta.history.length === 0, 'no reset mid-pinch');
  w.fire('touchend', { touches: [] });
  w.fire('room:overlay-closed'); await sleep(WAIT);
  ok(w.meta.history.length === 2 && w.meta.c === ORIG, 'resets once the touch ends');
}
{
  const w = world(1.2);
  mod.installZoomGuard();
  w.doc.activeElement = { tagName: 'IFRAME' }; w.fire('blur'); w.doc.activeElement = { tagName: 'BODY' }; w.fire('focus');
  await sleep(WAIT);
  ok(w.meta.history.length === 2, 'frame focus return resets');
}
{
  const w = world(1.2);
  mod.installZoomGuard();
  w.doc.activeElement = { tagName: 'BODY' }; w.fire('blur'); w.fire('focus');
  await sleep(WAIT);
  ok(w.meta.history.length === 0, 'plain blur/focus (not a frame) does not reset');
  w.fireDoc('visibilitychange'); await sleep(WAIT);
  ok(w.meta.history.length === 2 && w.meta.c === ORIG, 'visible again resets');
}
{
  globalThis.window = { addEventListener() {} }; globalThis.document = {};
  const g = mod.installZoomGuard();
  g.reset('x'); ok(true, 'no visualViewport: no-op, no throw');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
