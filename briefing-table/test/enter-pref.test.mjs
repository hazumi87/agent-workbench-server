/* USE ENTER TO SEND, live + Send menu [enter pref] Owner 2026-10-05: web/enter-pref.mjs run against
   stubs (broadcast on save, subscribers, refetch on visible/focus) plus source checks on the wiring. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* stubs */
const winL = {}; const docL = {};
const store = new Map();
globalThis.addEventListener = (t, f) => { (winL[t] ??= []).push(f); };
globalThis.document = { visibilityState: 'hidden', addEventListener: (t, f) => { (docL[t] ??= []).push(f); } };
globalThis.localStorage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) };
const posted = [];
globalThis.BroadcastChannel = class { constructor(n) { this.n = n; globalThis.__chan = this; } postMessage(m) { posted.push([this.n, m]); } };
let server = true; const calls = [];
globalThis.fetch = async (url, o) => {
  calls.push([url, o?.method ?? 'GET', o?.body]);
  if (o?.method === 'PATCH') { return { ok: server !== 'fail', json: async () => (server === 'fail' ? { error: 'nope' } : {}) }; }
  return { ok: true, json: async () => ({ enterSubmits: server === true }) };
};

const E = await import(pathToFileURL(join(W, 'enter-pref.mjs')).href);
const seen = [];
const off = E.onEnterSubmits((v) => seen.push(v));

await E.saveEnterSubmits(false);
ok(calls.at(-1)[1] === 'PATCH' && calls.at(-1)[2] === '{"enterSubmits":false}', 'save PATCHes /api/rooms/me {enterSubmits}');
ok(store.get('hwb.enterSubmits') === 'false', 'save writes hwb.enterSubmits to localStorage');
ok(posted.some(([n, m]) => n === 'hwb-prefs' && m.enterSubmits === false), "save posts on BroadcastChannel('hwb-prefs')");
ok(seen.join() === 'false', 'a local subscriber is told');

globalThis.__chan.onmessage({ data: { enterSubmits: true } });
ok(seen.at(-1) === true, 'a broadcast from another window updates subscribers');
winL.storage[0]({ key: 'hwb.enterSubmits', newValue: 'false' });
ok(seen.at(-1) === false, 'the storage event updates subscribers');
const n = seen.length;
globalThis.__chan.onmessage({ data: { enterSubmits: false } });
ok(seen.length === n, 'an unchanged value is not re-announced');

/* another device: refetch on visible and on focus, debounced */
server = true; calls.length = 0;
document.visibilityState = 'visible';
docL.visibilitychange[0](); winL.focus[0](); winL.focus[0]();
await sleep(500);
ok(calls.filter((c) => c[1] === 'GET').length === 1, 'visible + focus burst = ONE debounced GET /api/rooms/me');
ok(seen.at(-1) === true, 'the refetched value reaches subscribers');
document.visibilityState = 'hidden'; calls.length = 0;
docL.visibilitychange[0](); await sleep(400);
ok(calls.length === 0, 'hidden does not refetch');

/* failure: throws, nothing announced */
server = 'fail'; const m = seen.length; posted.length = 0;
let threw = false;
try { await E.saveEnterSubmits(false); } catch (e) { threw = /nope/.test(e.message); }
ok(threw && seen.length === m && posted.length === 0, 'a failed save throws and announces nothing');

/* a caller-owned transport (Settings save) */
server = true; let got = null;
await E.saveEnterSubmits(true, async (p) => { got = p; });
ok(got?.enterSubmits === true, 'saveEnterSubmits(v, patch) uses the caller transport');
off();

/* wiring */
const room = rd('room.js'), ac = rd('agent-chat.mjs'), you = rd('you-settings.mjs'), mod = rd('enter-pref.mjs');
ok(/attachSendMenu\(\$\('sendBtn'\)/.test(room) && /onEnterSubmits\(/.test(room), 'room composer Send has the menu and a live subscription');
ok(/attachSendMenu\(sendBtn/.test(ac) && /onEnterSubmits\(\(v\) => \{ enterSubmits = v; \}\)/.test(ac), 'agent chat Send has the menu and a live subscription');
ok(/saveEnterSubmits\(enterCb\.checked, save\)/.test(you) && /onEnterSubmits\(/.test(you), 'Settings uses the shared save and updates itself live');
ok(!/enterSubmits: enterCb/.test(you.replace(/saveEnterSubmits\(enterCb/g, '')), 'Settings has no private enterSubmits save left');
ok(/contextmenu/.test(mod) && /ContextMenu/.test(mod) && /F10/.test(mod) && /LONG_MS = 500/.test(mod), 'menu opens on right-click, ContextMenu / Shift+F10 and a 500 ms long-press');
ok(/Escape/.test(mod) && /onOutside/.test(mod) && /MOVE_PX/.test(mod), 'Escape, outside click and move-cancel are handled');
ok(/Use Enter to send/.test(mod) && /menuitemcheckbox/.test(mod), 'one checkbox row "Use Enter to send"');
ok(/\.rsm-menu \{/.test(rd('agent-chat.css')) && /\.rsm-menu \{/.test(rd('room.css')), 'the menu look exists on both pages');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
