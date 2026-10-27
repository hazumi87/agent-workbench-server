/**
 * The room composer re-reads the server draft when the page comes back
 * (ticket). Unit test: the SHIPPED draft code in web/room.js is sliced out and
 * run against stubs (no browser, no engine).
 *   - a newer server draft replaces a clean composer (text, reply chip, cursor
 *     at the end); an empty server draft (sent or cleared elsewhere) clears it;
 *   - unsaved typing is never overwritten: the "use it" button appears instead,
 *     and clicking it applies the server copy;
 *   - an older or equal updatedAt changes nothing;
 *   - one fetch per 30 seconds, none while hidden or offline, failures silent;
 *   - seenAt follows the load and the page's own successful save.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('async function noteSaved(r) {');
const b = src.indexOf("input.addEventListener('input', () => {");
if (a < 0 || b < a) {
  throw new Error('draft sync block not found in web/room.js');
}
const body = src.slice(a, b);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}

/** One page: `draft` is the shipped state object; the rest are stubs. */
function page({ serverDraft, online = true, hidden = false, fail = false } = {}) {
  const w = {
    now: 1_000_000,
    fetches: 0,
    server: serverDraft,
    restored: [],
    listeners: {},
    button: { hidden: true, onclick: null, addEventListener(t, f) { this.onclick = f; } },
    input: { value: '', sel: null, setSelectionRange(x, y) { this.sel = [x, y]; } },
    puts: [],
  };
  const fakeDate = { now: () => w.now };
  const stub$ = () => w.button;
  const api = async () => {
    w.fetches++;
    if (fail) {
      throw new Error('offline');
    }
    return { ok: true, body: w.server };
  };
  const make = new Function(
    'input', 'api', '$', 'roomId', 'Date', 'document', 'navigator', 'addEventListener', 'fitInput', 'paintCharLimit', 'replyUi',
    'localStorage', 'fetch', 'clearTimeout', 'setTimeout', 'isHidden', 'refreshCompletion',
    `const DRAFT_KEY = 'k'; const DRAFT_DEBOUNCE_MS = 400; const DRAFT_SYNC_MS = 30000; const DRAFT_TICK_MS = 8000;
     const draft = { timer: null, chain: Promise.resolve(), busy: 0, dirty: false, seenAt: null, askedAt: null, syncAt: 0, offer: null };
     const replyId = () => null; const dropLocalDraft = () => {}; const keepLocalDraft = () => {};
     const localDraft = () => null;
     function putDraft(text) { return fetch(text); }
     ${body}
     return { draft, syncDraft, restoreDraft, saveDraft, clearDraftMoved, onDraftStamp };`,
  );
  const api2 = make(
    w.input, api, stub$, 'r1', fakeDate, { hidden }, { onLine: online },
    (t, f) => { w.listeners[t] = f; }, () => { w.fit = true; }, () => { w.painted = true; },
    { restore: (r) => w.restored.push(r) },
    null,
    async (text) => {
      w.puts.push(text);
      return { ok: true, json: async () => ({ updatedAt: w.putAt }) };
    },
    clearTimeout, setTimeout,
    () => w.shellHidden || hidden,
    () => {},
  );
  return { w, ...api2 };
}

const reply = { id: 7, who: 'x' };

console.log('room draft sync');
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  ok(w.input.value === 'old' && draft.seenAt === 100, 'load: the box and seenAt come from the server draft');
  w.server = { text: 'from phone', updatedAt: 200, reply };
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === 'from phone', 'a newer server draft replaces a clean composer');
  ok(w.input.sel?.[0] === 10 && w.input.sel?.[1] === 10, 'the cursor goes to the end');
  ok(w.fit && w.painted && w.restored.at(-1) === reply, 'fit, char limit and the reply chip are restored');
  ok(draft.seenAt === 200 && w.button.hidden, 'seenAt moves up; no offer shown');
  w.server = { text: '', updatedAt: 300, reply: null };
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === '' && w.restored.at(-1) === null, 'an empty server draft (sent elsewhere) clears the composer and the chip');
}
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.input.value = 'my typing';
  draft.dirty = true;
  w.server = { text: 'newer', updatedAt: 200, reply: null };
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === 'my typing' && draft.dirty, 'unsaved typing is NOT overwritten');
  ok(w.button.hidden === false && draft.offer?.text === 'newer', 'the "use it" button appears');
  w.button.onclick();
  ok(w.input.value === 'newer' && draft.dirty && w.button.hidden && draft.seenAt === 200, 'clicking it applies the server text, dismisses, and schedules a save of the taken text');
}
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === 'old' && w.button.hidden, 'an equal updatedAt changes nothing');
  w.server = { text: 'older', updatedAt: 50, reply: null };
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === 'old', 'an older updatedAt changes nothing');
}
{
  const { w, syncDraft, restoreDraft } = page({ serverDraft: { text: 'a', updatedAt: 100, reply: null } });
  await restoreDraft();
  const before = w.fetches;
  w.now += 31_000;
  await syncDraft();
  await syncDraft(); // focus + visibility firing together
  w.now += 10_000;
  await syncDraft();
  ok(w.fetches === before + 1, 'one fetch inside 30 seconds, however many events');
  w.now += 31_000;
  await syncDraft();
  ok(w.fetches === before + 2, 'allowed again after 30 seconds');
}
{
  const off = page({ serverDraft: { text: 'a', updatedAt: 100, reply: null }, online: false });
  off.w.now += 31_000;
  await off.syncDraft();
  ok(off.w.fetches === 0, 'no fetch while offline');
  const hid = page({ serverDraft: { text: 'a', updatedAt: 100, reply: null }, hidden: true });
  hid.w.now += 31_000;
  await hid.syncDraft();
  ok(hid.w.fetches === 0, 'no fetch while hidden');
  const bad = page({ serverDraft: null, fail: true });
  bad.w.now += 31_000;
  let threw = false;
  try {
    await bad.syncDraft();
  } catch {
    threw = true;
  }
  ok(!threw && bad.w.input.value === '', 'a failed fetch is silent and leaves the box alone');
}
{
  const { w, draft, syncDraft, saveDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.input.value = 'mine';
  w.putAt = 250;
  await saveDraft();
  ok(draft.seenAt === 250, 'seenAt follows the page\'s own successful save');
  w.server = { text: 'mine', updatedAt: 250, reply: null };
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === 'mine' && w.button.hidden, 'the page\'s own save is not "newer from elsewhere"');
}
console.log('visible-page tick (guard 8 s)');
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  const before = w.fetches;
  w.now += 10_000;
  w.server = { text: 'phone', updatedAt: 200, reply: null };
  await syncDraft(8000);
  ok(w.fetches === before + 1 && w.input.value === 'phone', 'a tick 10 s after load fetches (the 30 s guard does not apply) and replaces a clean box');
  w.now += 5_000;
  await syncDraft(8000);
  ok(w.fetches === before + 1, 'a second tick inside 8 s does not fetch');
  w.now += 5_000;
  await syncDraft(8000);
  ok(w.fetches === before + 2, 'the next tick 10 s on fetches again');
  w.now += 2_000;
  await syncDraft(); // a focus event right after a tick: the 30 s guard
  ok(w.fetches === before + 2, 'a focus event right after a tick is the same fetch');
  w.now += 31_000;
  await syncDraft();
  ok(w.fetches === before + 3, 'a focus event after 30 s still fetches');
}
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.now += 31_000;
  await syncDraft(); // a focus event, then a tick 3 s later
  w.now += 3_000;
  const n = w.fetches;
  await syncDraft(8000);
  ok(w.fetches === n, 'a tick right after a focus fetch does not double-fetch');
}
{
  const off = page({ serverDraft: { text: 'a', updatedAt: 100, reply: null }, online: false });
  off.w.now += 10_000;
  await off.syncDraft(8000);
  const hid = page({ serverDraft: { text: 'a', updatedAt: 100, reply: null }, hidden: true });
  hid.w.now += 10_000;
  await hid.syncDraft(8000);
  ok(off.w.fetches === 0 && hid.w.fetches === 0, 'a tick fetches nothing while offline or hidden');
}
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.input.value = 'typing on pc';
  draft.dirty = true;
  w.now += 10_000;
  w.server = { text: 'phone text', updatedAt: 200, reply: null };
  await syncDraft(8000);
  ok(w.input.value === 'typing on pc' && !w.button.hidden && draft.offer?.text === 'phone text', 'a tick over a dirty box offers, never overwrites');
  w.now += 10_000;
  w.server = { text: 'phone text 2', updatedAt: 300, reply: null };
  await syncDraft(8000);
  ok(draft.offer?.text === 'phone text 2' && w.input.value === 'typing on pc', 'a later tick refreshes the offer');
}
{
  const { w, draft, syncDraft, saveDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.input.value = 'mine';
  draft.dirty = true;
  w.now += 10_000;
  w.server = { text: 'phone', updatedAt: 200, reply: null };
  await syncDraft(8000);
  ok(!w.button.hidden, 'offer is showing');
  w.putAt = 400;
  await saveDraft();
  ok(!w.button.hidden && draft.offer?.text === 'phone' && draft.seenAt === 400, 'the page\'s own save keeps the offer: it is the only copy of the other device\'s text left');
}
{
  const { w, draft, syncDraft, restoreDraft } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.shellHidden = true; // shell tab in the background: document.hidden stays false
  w.now += 31_000;
  w.server = { text: 'phone', updatedAt: 200, reply: null };
  const n = w.fetches;
  await syncDraft();
  await syncDraft(8000);
  ok(w.fetches === n && w.input.value === 'old', 'a shell-hidden tab fetches nothing (isHidden, though document.hidden is false)');
  w.shellHidden = false; // the shell shows the tab: onVisibility(true) -> syncDraft()
  await syncDraft();
  ok(w.fetches === n + 1 && w.input.value === 'phone', 'shown again by the shell: the draft is read and a clean box is replaced');
}
{
  /* NOTES [ticket]: after "Move draft to a note" the engine empties the server draft */
  const { w, draft, syncDraft, restoreDraft, clearDraftMoved } = page({ serverDraft: { text: 'long text', updatedAt: 100, reply: null } });
  await restoreDraft();
  w.server = { text: '', updatedAt: 500, reply: null }; // what the move-draft route left on the server
  await clearDraftMoved();
  ok(w.input.value === '' && !draft.dirty && draft.seenAt === 500 && w.button.hidden, 'a moved draft: composer empty, seenAt is the cleared server copy');
  w.now += 31_000;
  await syncDraft();
  ok(w.input.value === '' && w.button.hidden, 'the next sync tick resurrects nothing and offers nothing');
  w.input.value = 'new words';
  draft.dirty = true;
  w.now += 31_000;
  await syncDraft();
  ok(w.button.hidden && w.input.value === 'new words', 'typing right after the move raises no false "Newer draft" offer');
}
{
  /* the room poll's draft stamp: a changed stamp reads the draft once; unchanged reads nothing */
  const { w, draft, restoreDraft, onDraftStamp } = page({ serverDraft: { text: 'old', updatedAt: 100, reply: null } });
  await restoreDraft();
  const base = w.fetches;
  ok(onDraftStamp(100) === true && w.fetches === base, 'an unchanged stamp: no request');
  ok(onDraftStamp(null) === true && w.fetches === base, 'a null stamp (no draft): no request');
  w.server = { text: 'from laptop', updatedAt: 200, reply: null };
  ok(onDraftStamp(200) === true, 'a changed stamp is handled by the piggyback');
  await new Promise((r) => setTimeout(r, 0));
  ok(w.fetches === base + 1 && w.input.value === 'from laptop' && draft.seenAt === 200, 'a changed stamp: one GET, and the text arrives');
  onDraftStamp(200);
  ok(w.fetches === base + 1, 'the same stamp again (seen): no second GET');
  w.server = { text: 'x', updatedAt: 300, reply: null };
  w.input.value = 'typing';
  draft.dirty = true;
  onDraftStamp(300);
  onDraftStamp(300);
  await new Promise((r) => setTimeout(r, 0));
  ok(w.fetches === base + 2 && w.button.hidden === false, 'a stamp not yet taken: one GET per change, then offered while typing');
  ok(onDraftStamp(undefined) === false, 'no field (older engine): not handled, so the 10 s tick fallback runs');
}
{
  const src2 = src;
  const i = src2.indexOf('const got = await fetchRoom()');
  const seg = src2.slice(i, i + 700);
  ok(seg.includes('onDraftStamp(') && seg.includes('draftTick % 4 === 0') && seg.indexOf('onDraftStamp(') < seg.indexOf('draftTick % 4'), 'poll(): the 4th-tick read is only the fallback when no stamp arrived');
  const h = src2.indexOf('if (isHidden()) {', src2.indexOf('lastHiddenFetch = Date.now()') - 400);
  const hidden = src2.slice(h, src2.indexOf('const got = await fetchRoom()'));
  ok(!hidden.includes('syncDraft') && !hidden.includes('onDraftStamp'), 'a hidden tab poll never reads the draft');
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
