// The Image Viewer page's side of its host contract (the design notes). Everything the page reads or writes
// goes through the module bridge: the picture list, each picture's bytes and companion, the saves. Pure async, no
// DOM, so it runs against a fake bridge. The page never names a room, module or account; the host binds them.
//
//   image.init   {}                         -> {pictures:[{id, name, dir, rel}], start?, sent?}
//   files.read   {dir, rel, as:'dataUrl'}   -> {dataUrl}      (the picture)
//   files.read   {dir, rel, as:'text'}      -> {text}         (the companion; refused 'not-found' when there is none)
//   files.write  {dir, rel, text}           -> {ok:true}      (the companion; the host names no other file)
//   image.marks  {id, count}                -> {}             (best effort: the host's pencil on the thumbnail)
//   dismiss      {}                         -> {}             (Esc / Close: the host closes the column)
//   expand       {on}                       -> {}             (Expand / Collapse: the host resizes the column)
// Host events: 'theme' {--md-sys-color-*: colour}, 'image.state' {pictures, start, sent} (the list changed).

import { companionName } from './companion.js';

export const MAX_PICTURES = 50;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
/** What a companion that could not be read stands in as: the model refuses it and holds it, so nothing is written over it. */
export const UNREADABLE = '\u0000unreadable';
export const SAVE_RETRY_MS = 3000;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const base = (rel) => String(rel).split('/').pop();

/** The host's list, checked: a short list of plain entries, or null. */
export function cleanPictures(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PICTURES) return null;
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p !== 'object' || !ID.test(p.id) || seen.has(p.id)) return null;
    if (!isStr(p.name, 200) || !isStr(p.dir, 200) || !isStr(p.rel, 400) || companionName(base(p.rel)) === null) return null;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name, dir: p.dir, rel: p.rel });
  }
  return out;
}

export function createHost({ bridge, timers }) {
  const T = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  const retry = new Map(); // picture id -> {timer, text}

  async function init() {
    await bridge.ready;
    const r = await bridge.call('image.init', {});
    const pictures = cleanPictures(r && r.pictures);
    if (!pictures) throw Object.assign(new Error('The picture list is not usable.'), { code: 'bad-list' });
    const start = Number.isInteger(r.start) && r.start >= 0 && r.start < pictures.length ? r.start : 0;
    return { pictures, start, sent: r.sent === true };
  }

  /** One picture's data URL and its companion's text (null: none yet; UNREADABLE: could not be read, so held). */
  async function load(p) {
    const img = await bridge.call('files.read', { dir: p.dir, rel: p.rel, as: 'dataUrl' });
    if (!img || typeof img.dataUrl !== 'string' || !DATA_URL.test(img.dataUrl)) throw Object.assign(new Error('The picture could not be read.'), { code: 'bad-picture' });
    let companion = null;
    try {
      const c = await bridge.call('files.read', { dir: p.dir, rel: p.rel.slice(0, p.rel.length - base(p.rel).length) + companionName(base(p.rel)), as: 'text' });
      companion = c && typeof c.text === 'string' ? c.text : UNREADABLE;
    } catch (e) {
      companion = e && e.kind === 'refused' && (e.status === 404 || /not.?found/i.test(String(e.message))) ? null : UNREADABLE;
    }
    return { dataUrl: img.dataUrl, companion };
  }

  /** Write the companion. A failed write is kept and tried again in a few seconds and on the next change; never silent. */
  function save(p, text, { onFail = () => {}, onOk = () => {} } = {}) {
    const rel = p.rel.slice(0, p.rel.length - base(p.rel).length) + companionName(base(p.rel));
    const old = retry.get(p.id);
    if (old && old.timer) T.clear(old.timer);
    retry.delete(p.id);
    const attempt = (body) => bridge.call('files.write', { dir: p.dir, rel, text: body }).then(
      () => { retry.delete(p.id); onOk(); },
      (e) => {
        onFail(e);
        if (e && e.kind === 'revoked') return;
        if (e && e.kind === 'refused' && e.status === 409) return; // changed somewhere else: held, never sent blind again
        const timer = T.set(() => { if (retry.get(p.id) && retry.get(p.id).text === body) { retry.get(p.id).timer = null; void attempt(body); } }, SAVE_RETRY_MS);
        retry.set(p.id, { timer, text: body });
      });
    return attempt(text);
  }

  const call = (verb, input) => bridge.call(verb, input).catch(() => null); // the host's side effects: best effort
  return {
    init, load, save,
    marks: (id, count) => call('image.marks', { id, count }),
    dismiss: () => call('dismiss', {}),
    expand: (on) => call('expand', { on: !!on }),
    pending: () => retry.size,
  };
}
