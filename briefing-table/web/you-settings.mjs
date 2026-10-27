/* YOUR PICTURE + YOUR @NAME — global, per person, shown in every room (Owner
 * 2026-09-30: "This needs to move from room settings to global settings").
 * Previously this whole EDITOR lived inside each room's ⚙ column
 * (web/room.js). It is now mounted once, in global Settings
 * (web/settings.mjs's GROUPS contract) — the ONE place either is edited. The
 * room's ⚙ column only points there now (see room.js's youSettingsLink()).
 *
 * Two independent things live in this module:
 *   - youGlyph(me, big) / personIcon() / PICTURE_RE: pure rendering of the
 *     picture-or-monogram-or-person-icon look. Shared with room.js, which
 *     still needs it to paint the glyph beside every line in a room (that is
 *     a DIFFERENT concern from editing it, and stays in room.js).
 *   - mountYouSettings(el, {me, save}): the editable group, following global
 *     Settings' mount contract exactly (web/settings.mjs, top of file) —
 *     `save(patch)` PATCHes /api/rooms/me (a person's cookie only; a bearer
 *     gets 403) and merges the answer into the shared `me`. No engine change:
 *     this rides the same route the room's old editor used.
 */

import { saveEnterSubmits, onEnterSubmits } from '/enter-pref.mjs'; // [enter pref] Owner 2026-10-05: one save, live everywhere

export const PICTURE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function personIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'you-person');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(NS, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '8');
  head.setAttribute('r', '4');
  const body = document.createElementNS(NS, 'path');
  body.setAttribute('d', 'M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7');
  svg.append(head, body);
  return svg;
}

/** Your square picture, else your initial, else a person icon (never a
 *  letter taken from the word "you" — the design system FIX-1). `me` is a
 *  {picture, name}-like object: room.js's own `state.me`, or this module's
 *  own `me` when called from mountYouSettings. */
export function youGlyph(me, big) {
  const el = document.createElement('span');
  el.className = big ? 'you big' : 'you';
  const pic = me?.picture;
  if (typeof pic === 'string' && PICTURE_RE.test(pic)) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = pic; // a data: URL the engine checked; never a remote URL
    el.append(img);
  } else {
    const initial = (me?.name || '').trim()[0];
    if (initial) {
      el.textContent = initial.toUpperCase();
    } else {
      el.append(personIcon());
    }
  }
  return el;
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

/* picked here, cropped to a square and scaled to 256px in the page, stored by
   the engine as a small data: URL (PATCH /api/rooms/me) */
const PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PICK_MAX = 2 * 1024 * 1024;
const PIC_PX = 256;
const PIC_STORE_MAX = 256 * 1024; // the engine's cap on the stored picture

async function squarePicture(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const n = Math.min(PIC_PX, side);
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  cv.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, n, n);
  bmp.close?.();
  /* WebP where the browser encodes it; else PNG (keeps transparency); else
     a JPEG when a PNG would not fit the store's cap */
  let url = cv.toDataURL('image/webp', 0.9);
  if (!url.startsWith('data:image/webp')) {
    url = cv.toDataURL('image/png');
    if (url.length > (PIC_STORE_MAX / 3) * 4) {
      url = cv.toDataURL('image/jpeg', 0.9);
    }
  }
  return url;
}

/** Mounted into global Settings (web/settings.mjs's GROUPS contract, `id:
 *  'you'`, listed FIRST). `el` is the group's body (the frame + "You" <h4>
 *  are already drawn by the page); `me`/`save` per the contract. Returns
 *  {update(me)} so the page can repaint it when `me` changed elsewhere
 *  (another group's save, or a refetch on focus/visibilitychange). */
export function mountYouSettings(el, { me, save }) {
  const row = mk('div', 'pv-pic');
  const big = mk('span', 'pv-picbig');
  const acts = mk('div', 'pv-picacts');
  const choose = mk('button', 'pv-btn pri', 'Choose image…');
  choose.type = 'button';
  const remove = mk('button', 'pv-btn pv-txt', 'Remove (use the monogram)');
  remove.type = 'button';
  const file = mk('input');
  file.type = 'file';
  file.accept = PICK_TYPES.join(',');
  file.className = 'rm-sr';
  file.tabIndex = -1;
  file.setAttribute('aria-hidden', 'true');
  acts.append(choose, remove, file);
  row.append(big, acts);
  const prev = mk('div', 'pv-picprev');
  const small = mk('span', 'pv-picsmall');
  prev.append(small, 'How it looks at 28px beside a message.');
  const picMsg = mk('p', 'pv-msg');
  picMsg.setAttribute('role', 'status');

  const box = mk('div', 'pv-handle');
  const label = mk('label', 'pv-lbl', 'Your @name');
  label.htmlFor = 'meHandle';
  const handleRow = mk('div', 'pv-handlerow');
  const at = mk('span', 'pv-at', '@');
  const input = mk('input', 'pv-in');
  input.id = 'meHandle';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none');
  input.maxLength = 65;
  const handleSave = mk('button', 'pv-btn pri', 'Save');
  handleSave.type = 'button';
  handleRow.append(at, input, handleSave);
  const handleMsg = mk('p', 'pv-msg');
  handleMsg.setAttribute('role', 'status');
  box.append(label, handleRow, mk('p', 'pv-note', 'How agents address you in every room. Lowercase letters, digits and single hyphens.'), handleMsg);

  const paint = () => {
    big.replaceChildren(youGlyph(me, true));
    small.replaceChildren(youGlyph(me));
    remove.hidden = !me?.picture;
    if (document.activeElement !== input) {
      input.value = me?.handle ?? '';
    }
  };

  const savePicture = async (picture) => {
    picMsg.textContent = 'Saving…';
    picMsg.dataset.kind = '';
    try {
      await save({ picture });
      picMsg.textContent = 'Saved';
      paint();
    } catch (e) {
      picMsg.textContent = `Not saved: ${e?.message ?? e}`;
      picMsg.dataset.kind = 'error';
    }
  };
  choose.addEventListener('click', () => file.click());
  remove.addEventListener('click', () => void savePicture(null));
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) {
      return;
    }
    if (!PICK_TYPES.includes(f.type)) {
      picMsg.textContent = 'Not saved: pick a PNG, JPG or WebP image';
      picMsg.dataset.kind = 'error';
      return;
    }
    if (f.size > PICK_MAX) {
      picMsg.textContent = `Not saved: that image is ${(f.size / 1048576).toFixed(1)} MB; the limit is 2 MB`;
      picMsg.dataset.kind = 'error';
      return;
    }
    try {
      await savePicture(await squarePicture(f));
    } catch (e) {
      picMsg.textContent = `Not saved: that file could not be read as an image (${e?.message ?? e})`;
      picMsg.dataset.kind = 'error';
    }
  });

  const submitHandle = async () => {
    handleMsg.textContent = 'Saving…';
    handleMsg.dataset.kind = '';
    try {
      await save({ handle: input.value });
      input.value = me?.handle ?? '';
      handleMsg.textContent = 'Saved';
    } catch (e) {
      handleMsg.textContent = `Not saved: ${e?.message ?? e}`;
      handleMsg.dataset.kind = 'error';
    }
  };
  handleSave.addEventListener('click', () => void submitHandle());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void submitHandle();
    }
  });

  /* USE ENTER TO SEND (Owner 2026-10-04,): per person.
     Unset reads as ticked (today's default); unticking saves false. */
  const enterBox = mk('div', 'pv-handle');
  const enterLbl = mk('label', 'pv-lbl');
  const enterCb = mk('input');
  enterCb.type = 'checkbox';
  enterCb.id = 'meEnterSubmits';
  enterLbl.htmlFor = 'meEnterSubmits';
  enterLbl.append(enterCb, ' Use Enter to send');
  const enterMsg = mk('p', 'pv-msg');
  enterMsg.setAttribute('role', 'status');
  enterBox.append(enterLbl, mk('p', 'pv-note', 'Off: Enter adds a new line; send with the Send button.'), enterMsg);
  enterCb.addEventListener('change', async () => {
    enterMsg.textContent = 'Saving…';
    enterMsg.dataset.kind = '';
    try {
      await saveEnterSubmits(enterCb.checked, save);
      enterMsg.textContent = 'Saved';
    } catch (e) {
      enterCb.checked = me?.enterSubmits !== false;
      enterMsg.textContent = `Not saved: ${e?.message ?? e}`;
      enterMsg.dataset.kind = 'error';
    }
  });
  const paintEnter = () => {
    enterCb.checked = me?.enterSubmits !== false;
  };
  /* changed elsewhere (Send's menu, another window or device): repaint, no reload */
  onEnterSubmits((v) => {
    if (me) {
      me.enterSubmits = v;
    }
    enterCb.checked = v;
  });

  el.append(row, prev,
    mk('p', 'pv-note', "Shown beside your lines in every room. Square; it's cropped to a square if it isn't one. PNG, JPG or WebP, up to 2 MB."),
    picMsg, box, enterBox);
  paint();
  paintEnter();
  return { update: () => { paint(); paintEnter(); } };
}
