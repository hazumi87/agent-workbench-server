/* shell-update.mjs — the chrome-staleness watcher, unit level.
 *
 * In `npm test`: no engine, no browser. The module touches only `document`,
 * `fetch`, `window` and timers, all of which are injected or stubbed here, so
 * the LOGIC is testable without a shell — which matters because the thing it
 * guards against (a window running an old build) is by definition not
 * reproducible in a freshly-loaded page.
 */
import { ownStamp, servedStamp, watchForUpdate } from '../web/shell-update.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, label, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
};

/* A document stub: only querySelectorAll over a fixed element list. */
const docWith = (attrs) => ({
  querySelectorAll: () => attrs.map((a) => ({ getAttribute: (k) => a[k] ?? null })),
});

console.log('\n[ownStamp: reads the version the document was SERVED with]');
ok(ownStamp(docWith([{ src: '/shell-tabs.mjs?v=1789939118' }])) === '1789939118',
  'finds the stamp on a script src');
ok(ownStamp(docWith([{ href: '/manager.css?v=42' }])) === '42', 'and on a link href');
ok(ownStamp(docWith([{ src: '/a.js' }, { href: '/b.css?v=7' }])) === '7',
  'skips unstamped assets and keeps looking');
/* An unstamped document is a dev build serving files unrewritten. There is
   nothing to compare, so the watcher must stay silent rather than treat every
   poll as a new version. */
ok(ownStamp(docWith([{ src: '/a.js' }])) === null, 'an unstamped document yields null');
ok(ownStamp(docWith([])) === null, 'and so does an empty one');

console.log('\n[servedStamp: what the engine is serving NOW]');
const withFetch = async (impl, fn) => {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
};
ok(await withFetch(
  async () => ({ ok: true, text: async () => '<script src="/x.mjs?v=999"></script>' }),
  () => servedStamp('/app/shell.html'),
) === '999', 'parses the stamp out of the served HTML');
/* THE ENGINE BEING DOWN IS NOT A NEW BUILD. Any failure must read as "no
   answer", never as staleness — a watcher that cries wolf on a blip trains
   people to ignore the one marker that matters. */
ok(await withFetch(async () => { throw new Error('offline'); }, () => servedStamp()) === null,
  'a fetch failure is null, never a claim of staleness');
ok(await withFetch(async () => ({ ok: false }), () => servedStamp()) === null,
  'and so is a non-200');
ok(await withFetch(async () => ({ ok: true, text: async () => '<script src="/x.mjs"></script>' }),
  () => servedStamp()) === null, 'unstamped served HTML is null too');

console.log('\n[watchForUpdate: fires once, on a DIFFERENT stamp]');
const fakeWindow = () => {
  const handlers = {};
  return {
    addEventListener: (t, h) => { (handlers[t] ||= []).push(h); },
    removeEventListener: (t, h) => { handlers[t] = (handlers[t] || []).filter((x) => x !== h); },
    fire: async (t) => { for (const h of handlers[t] || []) { await h(); } },
    count: (t) => (handlers[t] || []).length,
  };
};
const run = async (servedSeq, { own = '100' } = {}) => {
  const prevWin = globalThis.window;
  const w = fakeWindow();
  globalThis.window = w;
  let i = 0;
  const calls = [];
  const stop = await withFetch(
    async () => ({ ok: true, text: async () => `<script src="/x.mjs?v=${servedSeq[Math.min(i++, servedSeq.length - 1)]}"></script>` }),
    async () => watchForUpdate({
      onStale: (served, mine) => calls.push([served, mine]),
      everyMs: 1e9, // the interval must never fire here; focus drives the test
      doc: docWith([{ src: `/shell.js?v=${own}` }]),
    }),
  );
  return { w, calls, stop, fireFocus: () => withFetch(
    async () => ({ ok: true, text: async () => `<script src="/x.mjs?v=${servedSeq[Math.min(i++, servedSeq.length - 1)]}"></script>` }),
    () => w.fire('focus'),
  ), restore: () => { stop(); globalThis.window = prevWin; } };
};

let t = await run(['100']);
await t.fireFocus();
ok(t.calls.length === 0, 'the SAME stamp is not an update');
t.restore();

t = await run(['101']);
await t.fireFocus();
ok(t.calls.length === 1, 'a different stamp fires once', JSON.stringify(t.calls[0]));
await t.fireFocus();
await t.fireFocus();
ok(t.calls.length === 1, '...and only once — a durable marker, not a nag');
ok(t.w.count('focus') === 0, '...and it unhooks itself when it fires');
t.restore();

/* A ROLLBACK IS ALSO STALE. A window running art nobody is serving any more is
   as wrong as one running an older build, so the test is inequality, not
   "greater than". */
t = await run(['99']);
await t.fireFocus();
ok(t.calls.length === 1, 'an OLDER served stamp counts too (a rollback)', JSON.stringify(t.calls[0]));
t.restore();

/* An unstamped document cannot compare, so the watcher must not even listen —
   otherwise every poll in a dev build reads as a new version. */
const prevWin = globalThis.window;
const w2 = fakeWindow();
globalThis.window = w2;
const stop2 = watchForUpdate({ onStale: () => {}, doc: docWith([{ src: '/a.js' }]) });
ok(w2.count('focus') === 0, 'an unstamped window registers no listeners at all');
ok(typeof stop2 === 'function', '...and still returns a stop function');
stop2();
globalThis.window = prevWin;

console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
