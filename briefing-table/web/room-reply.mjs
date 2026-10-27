/* REPLY TO A LINE (the design system room-reply-v1, Owner 2026-09-28).
 *
 * START: a desktop hover / focus-within pill on the line's top outer corner
 * (right for others' lines, left for yours): ↩ Reply + ⋯. Right-click, the ⋯
 * and Shift+F10 open THE SEAT-MENU COMPONENT (room-seat-menu.mjs
 * createMenuHost / wireMenuOpeners / menuToast): a title row (@author in ink
 * + the time) and Reply (R) · Copy text · Copy line link (#id). Lines are
 * focusable: ↑ from an empty composer steps into the line, ↑/↓ move, R
 * replies, Esc goes back. Phone: swipe right (starting >= 24px from the
 * screen edge) reveals a ↩ disc that turns teal at 56px, release replies;
 * a long press opens the same menu as a bottom sheet. Voice lines and facts
 * too (a fact has no hover pill, as in the mockup).
 *
 * THE COMPOSER: the quote chip goes FIRST in the attachment tray (room-attach
 * setLead), focus goes to the input. One at a time (a new reply replaces it);
 * Esc in the input drops it (unless the @-list is open). The target rides the
 * SERVER DRAFT (room.js puts reply_to with the text), so it survives a
 * refresh. The chip tells the truth about routing (engine rule, rooms.ts
 * replySeat): a reply to a seat's line goes to that seat (REPLY ALL, Owner
 * 2026-10-03: plus every seat the line @-mentioned, as a leading @ run); your own line, a
 * fact, the voice agent or a seat that left go where normal routing sends
 * them ("· to @lead"); a leading @address in the text wins either way.
 *
 * THE SENT LINE: meta.reply (captured by the engine at send time) draws a
 * quote header INSIDE the bubble above the body — an inset box, no left bar.
 * It is a button: the original scrolls to the middle and flashes with the
 * lift; a "↓ Back to latest" pill shows until you are back down. Not loaded:
 * older pages load until it arrives (a spinner in the header); gone: dim
 * italic "Original not available". No nested quotes.
 *
 * This module owns no room state; room.js hands it thin hooks (mountReply).
 */
import { createMenuHost, wireMenuOpeners, menuToast } from '/room-seat-menu.mjs';
import { stripMarks } from '/markdown-plain.mjs';
import { quoteOf } from '/room-quote.mjs';
import { replyAllHandles, replyAllPrefix } from '/room-reply-all.mjs';

const SVGNS = 'http://www.w3.org/2000/svg';
const PHONE = '(max-width: 600px)';
const SWIPE_EDGE = 24; // iOS keeps its back-swipe edge
const SWIPE_ARM = 56; // the disc turns teal; release here replies
const SWIPE_MAX = 88;
const FLASH_HOLD_MS = 150; // the lift at full, then it fades (.9s, CSS)
const JUMP_SETTLE_MS = 1000; // a smooth scroll to the original has landed by then
const OLDER_PAGES_MAX = 200; // "load older until it arrives" — bounded, never a spin

const PATHS = {
  reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  x: '<path d="M2 2l6 6M8 2l-6 6"/>',
};
function icon(key, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', key === 'x' ? '0 0 10 10' : '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  if (cls) {
    s.setAttribute('class', cls);
  }
  s.innerHTML = PATHS[key]; // a constant
  return s;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}
function metaOf(e) {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}
/** A stored meta.reply, when it is one. */
export function replyOfEntry(e) {
  const r = metaOf(e)?.reply;
  return r && typeof r === 'object' && Number.isInteger(r.id) && typeof r.excerpt === 'string' ? r : null;
}
const LEADING = /^@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/;
const isPhone = () => matchMedia(PHONE).matches;

/**
 * @param {object} o
 *   roomId; line (#line), scroll (#lineScroll), column (#roomLine), input,
 *   att: room-attach's API (setLead);
 *   entry(id) -> the loaded entry | undefined;
 *   seats() -> active seats; leadId() -> the lead seat id | null;
 *   seatHandle(id) -> handle | null; userHandle() -> your @name | null;
 *   tone(span) -> the page's @name toning (room.js toneMention);
 *   toneOf(seatId) -> the seat's colour | null (the menu title's ink);
 *   loadOlder() -> Promise; atStart() -> bool; minId() -> id | null;
 *   showAll() -> lift the line filters (the original is hidden by one);
 *   completionOpen() -> the @-list is up; draftChanged() -> save the draft
 */
export function mountReply(o) {
  const host = createMenuHost();
  let target = null; // the ReplyRef the composer holds, or null
  let chip = null;

  /* ------------------------------------------------------------ helpers ---- */
  const nodeOf = (id) => o.line.querySelector(`li[data-id="${id}"]`);
  const visibleLines = () => [...o.line.querySelectorAll('li.rp-line')].filter((li) => li.style.display !== 'none');
  function refFor(e) {
    return quoteOf(e, { userHandle: o.userHandle() ?? 'you', seatHandle: (id) => o.seatHandle(id) });
  }
  function mentionSpan(handle, cls) {
    const s = el('span', `mention ${cls}`, `@${handle}`);
    s.dataset.h = String(handle).toLowerCase();
    o.tone(s);
    return s;
  }
  function timeOf(e) {
    const d = new Date(e.ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function lineLink(id) {
    const u = new URL(location.href);
    u.hash = `line-${id}`;
    return u.toString();
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* insecure context / refused: the textarea path (a textarea keeps newlines) */
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.append(t);
      t.select();
      let done = false;
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      t.remove();
      return done;
    }
  }

  /* ---------------------------------------------------- the composer chip ---- */
  /** Where the line will go, in words — the engine's rule (rooms.ts replySeat). */
  function routeWords(ref) {
    const text = o.input.value.trim();
    const lead = LEADING.exec(text);
    const seat = ref.seat ? o.seats().find((s) => s.id === ref.seat) : null;
    if (lead) {
      const to = lead[1].toLowerCase();
      /* REPLY PREFILL: "@buddy " in front of a reply to @buddy says nothing
         the chip's "Replying to @buddy" does not */
      return { to, implied: !!seat && seat.handle.toLowerCase() === to && !ref.user };
    }
    if (seat) {
      return { to: seat.handle, implied: true }; // "Replying to @author" says it
    }
    const leadSeat = o.seats().find((s) => s.id === o.leadId());
    return { to: leadSeat ? leadSeat.handle : null, implied: false };
  }
  function paintChipRoute() {
    if (!chip || !target) {
      return;
    }
    const l1 = chip.querySelector('.rp-l1');
    l1.replaceChildren();
    l1.append('Replying to ');
    if (target.handle === null) {
      l1.append('a fact');
    } else if (target.user) {
      l1.append('your line');
    } else {
      const b = mentionSpan(target.handle, 'rp-who');
      l1.append(b);
    }
    const r = routeWords(target);
    if (!r.implied) {
      const to = el('span', 'rp-to');
      if (r.to) {
        to.append(` ${String.fromCharCode(0xb7)} to `, mentionSpan(r.to, 'rp-who'));
      } else {
        to.append(` ${String.fromCharCode(0xb7)} no lead yet`);
      }
      l1.append(to);
    }
    const plain = l1.textContent;
    chip.setAttribute('aria-label', plain);
    chip.title = `${plain}: ${target.excerpt}`;
  }
  function buildChip(ref) {
    const c = el('div', 'rp-chip');
    c.setAttribute('role', 'listitem');
    c.dataset.id = String(ref.id);
    c.append(icon('reply', 'rp-ic'), el('div', 'rp-l1'), el('div', 'rp-l2', stripMarks(ref.excerpt)));
    const x = el('button', 'att-x rp-x');
    x.type = 'button';
    x.title = 'Stop replying (Esc)';
    x.setAttribute('aria-label', 'Stop replying');
    x.append(icon('x'));
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dropPrefill(); // REPLY PREFILL: a cancel takes back an untouched "@handle "
      clear();
      o.input.focus();
    });
    c.append(x);
    return c;
  }
  /** Hold `ref` as the reply target (replacing any other). */
  function set(ref, { focus = true, save = true } = {}) {
    if (!ref || !Number.isInteger(ref.id)) {
      return;
    }
    target = ref;
    chip = buildChip(ref);
    o.att.setLead(chip);
    paintChipRoute();
    if (focus) {
      o.input.focus({ preventScroll: true });
    }
    if (save) {
      o.draftChanged();
    }
  }
  function clear({ save = true } = {}) {
    if (!target) {
      return;
    }
    target = null;
    chip = null;
    o.att.setLead(null);
    if (save) {
      o.draftChanged();
    }
  }
  /* ==== REPLY PREFILL (Owner 2026-09-28): replying to a SEAT's line starts
   * the composer with "@<handle> ", caret after it, unless the text already
   * leads with an @address. Your own line, a fact, a voice line: nothing.
   * A cancel (the chip's x, Esc) takes the prefix back ONLY while the
   * composer is exactly what the prefill left; any edit and the text stays.
   * A new reply over an untouched prefill replaces it (a cancel + a start).
   * The draft keeps whatever the composer holds (the input event saves it). */
  let prefill = null; // {prefix, value}: what was put in, and the composer right after
  /* REPLY ALL (Owner 2026-10-03): the author AND every seat the line @-mentioned
     (web/room-reply-all.mjs); your own line: the seats it referenced. A fact
     or a voice line: nothing, as before. */
  function prefixFor(e) {
    if (e.kind === 'voice' || (!e.author_seat && e.author === 'room')) {
      return null;
    }
    const seats = o.seats();
    const leadSeat = seats.find((s) => s.id === o.leadId());
    const author = e.author_seat ? (o.seatHandle(e.author_seat) ?? e.author) : null;
    const handles = replyAllHandles({
      body: e.body,
      author: typeof author === 'string' ? author : null,
      seats: seats.map((s) => s.handle),
      leadHandle: leadSeat?.handle ?? null,
      me: o.userHandle(),
    });
    return handles.every((h) => LEADING.exec(`@${h}`)?.[0] === `@${h}`) ? replyAllPrefix(handles) || null : null;
  }
  function composerChanged() {
    o.input.dispatchEvent(new Event('input', { bubbles: true })); // the draft, the height, the chip route
  }
  function applyPrefill(e) {
    let v = o.input.value;
    if (prefill && v === prefill.value) {
      v = v.slice(prefill.prefix.length); // the last reply's prefill, untouched
      o.input.value = v;
    }
    const had = prefill;
    prefill = null;
    const prefix = prefixFor(e);
    if (!prefix || LEADING.test(v.trimStart())) {
      if (had && o.input.value !== had.value) {
        composerChanged();
      }
      return;
    }
    o.input.value = prefix + v;
    o.input.setSelectionRange(prefix.length, prefix.length);
    prefill = { prefix, value: o.input.value };
    composerChanged();
  }
  function dropPrefill() {
    const p = prefill;
    prefill = null;
    if (p && o.input.value === p.value) {
      o.input.value = p.value.slice(p.prefix.length);
      composerChanged();
    }
  }
  /* ==== /REPLY PREFILL ==== */
  function startReply(e) {
    set(refFor(e));
    applyPrefill(e); // REPLY PREFILL
  }
  o.input.addEventListener('input', paintChipRoute);
  o.input.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.isComposing) {
      return; // the @-list (room.js) took it
    }
    if (ev.key === 'Escape' && target && !o.completionOpen()) {
      ev.preventDefault();
      ev.stopPropagation(); // one Esc drops only the chip
      dropPrefill(); // REPLY PREFILL: a cancel takes back an untouched "@handle "
      clear();
    } else if (ev.key === 'ArrowUp' && !o.input.value && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      const lines = visibleLines();
      const last = lines[lines.length - 1];
      if (last) {
        ev.preventDefault();
        last.focus();
        last.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  /* ----------------------------------------------------------- the menu ---- */
  function openMenu(li, e, point, more) {
    const byRoom = e.author === 'room' && !e.author_seat;
    const byUser = e.author === 'user' && !e.author_seat;
    const title = byRoom ? 'fact' : byUser ? 'you' : `@${e.author_seat ? (o.seatHandle(e.author_seat) ?? e.author) : e.author}`;
    const tone = e.author_seat ? o.toneOf(e.author_seat) : null;
    const phone = isPhone();
    host.open({
      row: li,
      more: more ?? null,
      point,
      label: `Line #${e.id}`,
      title,
      sub: timeOf(e),
      ...(tone ? { tone } : {}),
      data: { menu: 'line', line: String(e.id) },
      items: [
        { a: 'reply', label: 'Reply', icon: 'reply', ...(phone ? {} : { k: 'R' }) },
        { a: 'copy', label: 'Copy text', icon: 'copy' },
        { a: 'link', label: 'Copy line link', icon: 'link', k: `#${e.id}` },
      ],
      choose(it) {
        host.close(false);
        if (it.a === 'reply') {
          startReply(e);
        } else if (it.a === 'copy') {
          /* Owner 2026-10-03: the bubble body's visible text (links and @names as
             shown, no meta line, no quote header); copy() writes inside this
             click, before any await, so the insecure-context path keeps the gesture */
          const shown = (li.querySelector('.entry-body') ?? li).textContent;
          void copy(shown || (e.body ?? replyOfEntry(e)?.excerpt ?? '')).then((done) => menuToast(done ? 'Copied the text' : 'Could not copy', null, null, done ? {} : { kind: 'error' }));
        } else if (it.a === 'link') {
          void copy(lineLink(e.id)).then((done) => menuToast(done ? `Copied the link to #${e.id}` : 'Could not copy', null, null, done ? {} : { kind: 'error' }));
        }
      },
      closed(back, refocus) {
        if (refocus) {
          (back?.more?.isConnected ? back.more : back?.row)?.focus({ preventScroll: true }); // where it came from
        }
      },
    });
    /* the menu component draws ITS icon set; the line's icons are painted in
       here until they are added there (no fork of the component) */
    const m = document.querySelector('.rsm-menu[data-menu="line"]');
    for (const key of ['reply', 'copy', 'link']) {
      const s = m?.querySelector(`.rsm-mi[data-a="${key}"] svg`);
      if (s) {
        s.innerHTML = PATHS[key];
      }
    }
    if (point && m && m.classList.contains('is-sheet')) {
      m.setAttribute('aria-modal', 'true');
    }
  }

  /* ----------------------------------------------------- the quote header ---- */
  function quoteHeader(ref) {
    const b = el('button', 'rp-qh');
    b.type = 'button';
    b.dataset.jump = String(ref.id);
    b.append(icon('reply', 'rp-qr'));
    if (ref.handle === null) {
      b.append(el('span', 'rp-qa rp-fact', 'fact'));
    } else {
      b.append(mentionSpan(ref.handle, 'rp-qa'));
    }
    if (ref.voice) {
      const v = el('span', 'rp-qi');
      v.append(icon('mic'));
      b.append(v);
    }
    b.append(el('span', 'rp-qt', stripMarks(ref.excerpt)));
    if (typeof ref.thumb === 'string' && ref.thumb && !ref.thumb.includes('/')) {
      const img = document.createElement('img');
      img.className = 'rp-thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.src = `/api/rooms/${encodeURIComponent(o.roomId)}/assets/raw/${encodeURIComponent(ref.thumb)}`;
      b.append(img);
    }
    b.title = `Go to the original (#${ref.id})`;
    b.setAttribute('aria-label', `Replying to ${ref.handle === null ? 'a fact' : `@${ref.handle}`}: ${ref.excerpt}. Go to the original.`);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void jump(ref.id, b);
    });
    /* above the loaded window with nothing older left: it is gone */
    if (!o.entry(ref.id) && o.atStart() && o.minId() !== null && ref.id < o.minId()) {
      markGone(b, ref);
    }
    return b;
  }
  function markGone(b, ref) {
    b.classList.add('gone');
    b.disabled = true;
    b.removeAttribute('title');
    const qt = b.querySelector('.rp-qt');
    qt.textContent = `Original not available ${String.fromCharCode(0xb7)} "${ref.excerpt}"`;
    b.setAttribute('aria-label', `Replying to a line that is no longer available: ${ref.excerpt}`);
  }

  /* ------------------------------------------------------- jump + flash ---- */
  const latest = el('button', 'rp-latest', `${String.fromCharCode(0x2193)} Back to latest`);
  latest.type = 'button';
  latest.hidden = true;
  o.column.append(latest);
  function placeLatest() {
    const c = o.column.getBoundingClientRect();
    const s = o.scroll.getBoundingClientRect();
    latest.style.bottom = `${Math.max(12, Math.round(c.bottom - s.bottom + 12))}px`;
  }
  const atBottom = () => o.scroll.scrollHeight - o.scroll.scrollTop - o.scroll.clientHeight < 40;
  /* the jump's own smooth scroll starts AT the bottom: its first frames must
     not read as "back down" */
  let jumpingUntil = 0;
  o.scroll.addEventListener('scroll', () => {
    if (!latest.hidden && Date.now() > jumpingUntil && atBottom()) {
      latest.hidden = true;
    }
  }, { passive: true });
  latest.addEventListener('click', () => {
    latest.hidden = true;
    o.scroll.scrollTo({ top: o.scroll.scrollHeight, behavior: 'smooth' });
  });
  addEventListener('resize', () => {
    if (!latest.hidden) {
      placeLatest();
    }
  });

  function flash(li) {
    li.classList.remove('rp-flash');
    void li.offsetWidth; // restart
    li.classList.add('rp-flash');
    setTimeout(() => li.classList.remove('rp-flash'), FLASH_HOLD_MS);
  }
  /** Scroll the original to the middle and flash it; load older pages until
   *  it arrives; say so when it cannot. Never throws. */
  async function jump(id, header) {
    try {
      let li = nodeOf(id);
      if (!li) {
        header?.classList.add('is-loading');
        header?.setAttribute('aria-busy', 'true');
        try {
          for (let i = 0; i < OLDER_PAGES_MAX && !nodeOf(id) && !o.atStart(); i++) {
            const before = o.minId();
            await o.loadOlder();
            if (o.minId() === before && !o.atStart()) {
              break; // a page that brought nothing: never spin
            }
          }
        } finally {
          header?.classList.remove('is-loading');
          header?.removeAttribute('aria-busy');
        }
        li = nodeOf(id);
        if (!li) {
          const ref = header ? replyOfEntry(o.entry(Number(header.closest('li')?.dataset.id)) ?? {}) : null;
          if (header && ref) {
            markGone(header, ref);
          } else {
            menuToast(`#${id} is not available`);
          }
          return;
        }
      }
      if (li.style.display === 'none') {
        o.showAll();
      }
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      jumpingUntil = Date.now() + JUMP_SETTLE_MS;
      li.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      flash(li);
      placeLatest();
      latest.hidden = false;
      setTimeout(() => {
        if (atBottom()) {
          latest.hidden = true; // the original was near the end: nothing to go back to
        }
      }, JUMP_SETTLE_MS);
    } catch (e) {
      menuToast(`Could not reach #${id}: ${e?.message ?? e}`, null, null, { kind: 'error' });
    }
  }

  /* ----------------------------------------------------- phone: swipe ---- */
  function wireSwipe(li, e) {
    let s = null; // {x, y, id, on, disc}
    const reset = () => {
      if (!s) {
        return;
      }
      li.classList.remove('rp-swiping');
      li.style.transform = '';
      s.disc?.remove();
      s = null;
    };
    li.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'touch' || ev.clientX < SWIPE_EDGE || ev.target.closest('button, a, input, textarea')) {
        return;
      }
      s = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, on: false, disc: null, dx: 0 };
    });
    li.addEventListener('pointermove', (ev) => {
      if (!s || ev.pointerId !== s.id) {
        return;
      }
      const dx = ev.clientX - s.x;
      const dy = ev.clientY - s.y;
      if (!s.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
          s = null; // a scroll, not a swipe
          return;
        }
        if (dx > 10 && dx > Math.abs(dy) * 1.2) {
          s.on = true;
          li.classList.add('rp-swiping');
          s.disc = el('span', 'rp-disc');
          s.disc.append(icon('reply'));
          li.prepend(s.disc);
        } else {
          return;
        }
      }
      s.dx = Math.max(0, Math.min(dx, SWIPE_MAX));
      li.style.transform = `translateX(${s.dx}px)`;
      s.disc.classList.toggle('on', s.dx >= SWIPE_ARM);
    });
    const end = (ev) => {
      if (!s || ev.pointerId !== s.id) {
        return;
      }
      const fire = s.on && s.dx >= SWIPE_ARM && ev.type === 'pointerup';
      reset();
      if (fire) {
        try {
          navigator.vibrate?.(10);
        } catch {
          /* no haptics */
        }
        startReply(e);
      }
    };
    li.addEventListener('pointerup', end);
    li.addEventListener('pointercancel', end);
  }

  /* ---- phone: the gutter beside a bubble (Owner 2026-10-03) ----
     A row is as wide as its bubble (max 84%, pushed to one side), so the empty
     space beside it is the list's, not the row's. A long press there opens the
     menu of the row at that height; no selection starts there (CSS, user-select:
     none), and the text itself is left to the browser. */
  const LONG_PRESS_MS = 500;
  const GUTTER_REACH = 14; // px above/below a row that still counts as its row (the margins)
  {
    let timer = 0;
    let at = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = 0;
    };
    const rowAt = (y) => {
      let best = null;
      let bestD = GUTTER_REACH + 1;
      for (const li of visibleLines()) {
        const r = li.getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < bestD) {
          best = li;
          bestD = d;
        }
      }
      return best;
    };
    o.scroll.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'touch' || ev.target.closest('li, button, a, input, textarea')) {
        return; // a row has its own opener; only the empty space is ours
      }
      at = { x: ev.clientX, y: ev.clientY };
      timer = setTimeout(() => {
        timer = 0;
        try {
          const li = rowAt(at.y);
          const e = li ? o.entry(Number(li.dataset.id)) : null;
          if (li && e) {
            openMenu(li, e, at, null);
          }
        } catch (err) {
          menuToast(`Could not open the menu: ${err?.message ?? err}`, null, null, { kind: 'error' });
        }
      }, LONG_PRESS_MS);
    });
    o.scroll.addEventListener('pointerup', cancel);
    o.scroll.addEventListener('pointercancel', cancel);
    o.scroll.addEventListener('pointermove', (ev) => {
      if (timer && at && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 10) {
        cancel();
      }
    });
  }

  /* ------------------------------------------------------- entryNode hook ---- */
  /**
   * Called by room.js entryNode for every line node it draws: the quote
   * header (a sent reply), the hover pill, the menu openers, the keyboard and
   * the swipe. A delivery note under a message is not a line of its own.
   */
  function decorate(li, e) {
    if (e.kind === 'delivery' || li.dataset.side) {
      return;
    }
    const bubble = li.querySelector(':scope > .entry-bubble');
    const body = bubble?.querySelector(':scope > .entry-body');
    const ref = replyOfEntry(e);
    if (ref && bubble && body) {
      bubble.insertBefore(quoteHeader(ref), body);
    }
    li.classList.add('rp-line');
    li.tabIndex = -1;
    let more = null;
    if (bubble) {
      const acts = el('div', 'rp-acts');
      const rb = el('button', 'rp-act');
      rb.type = 'button';
      rb.dataset.a = 'reply';
      rb.title = 'Reply (R)';
      rb.setAttribute('aria-label', 'Reply');
      rb.append(icon('reply'));
      rb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startReply(e);
      });
      more = el('button', 'rp-act');
      more.type = 'button';
      more.dataset.a = 'more';
      more.title = 'More';
      more.setAttribute('aria-label', 'More');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.append(icon('more'));
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openMenu(li, e, null, more);
      });
      acts.append(rb, more);
      bubble.append(acts);
    }
    /* a line with a text selection keeps the browser's own menu (copy) */
    li.addEventListener('contextmenu', (ev) => {
      const sel = getSelection();
      if (sel && !sel.isCollapsed && li.contains(sel.anchorNode)) {
        ev.stopImmediatePropagation();
      }
    }, true);
    /* Owner 2026-10-03: on touch, a press that starts ON the message text is the
       browser's (native selection); the menu opens from everywhere else on the
       row, and from the gutter beside the bubble (the gutter block below) */
    wireMenuOpeners(li, (point) => openMenu(li, e, point, point ? null : more), (ev) => ev.target === li, (ev) => !ev.target.closest('.entry-body'));
    li.addEventListener('keydown', (ev) => {
      if (ev.target !== li || ev.altKey || ev.ctrlKey || ev.metaKey) {
        return;
      }
      if (ev.key === 'r' || ev.key === 'R') {
        ev.preventDefault();
        startReply(e);
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        const lines = visibleLines();
        const i = lines.indexOf(li);
        const next = lines[i + (ev.key === 'ArrowUp' ? -1 : 1)];
        if (next) {
          next.focus();
          next.scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'ArrowDown') {
          o.input.focus();
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        o.input.focus();
      }
    });
    wireSwipe(li, e);
  }

  /** A line link (#line-<id>): jump to it once the line has loaded. A tool
   *  link's copied link adds `~<tool>:<ref>` (web/room-tool-links.mjs opens
   *  it once the line is there); the jump is the same. */
  function openHash() {
    const m = /^#line-(\d+)(?:~[^#]*)?$/.exec(location.hash);
    if (m) {
      void jump(Number(m[1]), null);
    }
  }
  addEventListener('hashchange', openHash);

  return {
    decorate,
    /** the ReplyRef the composer holds, or null */
    target: () => target,
    /** start replying to line `e` (what the menu's Reply does): [approval ask] Cancel */
    start: startReply,
    /** restore from the draft: no save (it came from there), no focus */
    restore(ref) {
      prefill = null; // REPLY PREFILL: a restored draft's text is the user's
      if (ref && typeof ref === 'object') {
        set(ref, { focus: false, save: false });
      } else {
        clear({ save: false });
      }
    },
    /** the line went out: the engine cleared the draft's target with it */
    sent() {
      prefill = null; // REPLY PREFILL
      clear({ save: false });
    },
    /** the roster moved (a seat came, left, the lead changed): the chip's route */
    repaint: paintChipRoute,
    jump,
    openHash,
  };
}
