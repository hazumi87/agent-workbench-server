/* ============================================================================
   hwb-mcp.js — the MCP-call indicator in the session bar (v27).

   Ruled by owner ruling 2026-09-25 (the design decisions page › "Decided — MCP indicator";
   reference mockup the design page):

       title ──── [MCP · Server · verb]

   M1 · the WIRE fills the bar's spacer after the title and ends FLUSH on the
        first chip's edge. A call's start sends a packet OUT (agent → MCP) in
        --mcp-out; its end sends a packet BACK (MCP → agent) in the result
        color. A call still running after `longAfterMs` shows the AB·B segment
        relay on the wire and an elapsed time on its chip.
   C2 · one wire, a strip of chips: the NEWEST is first and written out; older
        ones are compact (server + result); only chips that fit WHOLE show (at
        most `maxChips`), the rest fold into +N, which takes the LOUDEST hidden
        call's color (a failure never hides), and whose hover/focus lists them.

   The component shows only what it is told. A call whose source CAN'T report
   an end (`expectEnd: false`, e.g. a server that publishes only `invoked`)
   goes gray after `timeoutMs`: "no reply signal". Any other call waits for
   end() (dispatches run for minutes) up to a `staleMs` safety limit. A call is
   never shown as a success nobody saw.

   Data is the consumer's job (Claude Code tool hooks, NATS telemetry.mcp.*).
   This module owns only the look and the timing.
   ============================================================================ */

const RANK = ['s-err', 's-warn', 's-out', 's-ok', 's-none'];   // loudest first
const RES_CLASS = { ok: 's-ok', warn: 's-warn', error: 's-err', none: 's-none' };
const WHY_WORD = { isError: 'returned an error', failed: 'failed', denied: 'denied by permission', interrupted: 'interrupted' };
const RES_WORD = { 's-ok': 'ok', 's-warn': 'warn', 's-err': 'failed', 's-none': 'no reply signal' };

const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = ms => ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
  : `${Math.floor(ms / 60000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;

/**
 * Attach the indicator to a session bar (.hwb-sbar rendered by hwbRenderSessionBar).
 * The element survives later hwbRenderSessionBar calls on the same bar.
 *
 * @param {HTMLElement} bar
 * @param {Object} [opts]  { longAfterMs=3000, timeoutMs=30000, staleMs=1800000, holdMs=4000, dimMs=8000, maxChips=3, now=Date.now }
 * @returns {{ start(id, call), end(id, result), clear(), destroy(), el }}
 *   call   = { server, label?, verb, caller?: { kind: 'agent'|'sub', name? }, expectEnd?: boolean (default true), ts? }
 *   result = { result: 'ok'|'warn'|'error', ms?, why? }
 *   The WHOLE engine event (pane.mcp) may be passed to either; extra fields are ignored.
 *   `ts` (epoch ms) is when the call really started: a reconnecting window replays
 *   in-flight starts with their original ts, so elapsed = now − ts and no second out packet.
 *   `why` may be the engine's closed enum (isError | failed | denied | interrupted).
 */
export function hwbMcpIndicator(bar, opts = {}) {
  const o = { longAfterMs: 3000, timeoutMs: 30000, staleMs: 1800000, holdMs: 4000, dimMs: 8000, maxChips: 3, now: () => Date.now(), ...opts };
  let el = bar.querySelector(':scope > .hwb-mcp');
  if (!el) {
    el = document.createElement('span');
    el.className = 'hwb-mcp is-idle';
    el.innerHTML = '<span class="mw" aria-hidden="true"><span class="mw-relay"><i></i><i></i><i></i><i></i><i></i></span></span><span class="mc"></span>';
    (bar.querySelector(':scope > .sb-sp') || bar.lastChild).replaceWith(el);
  }
  const wire = el.querySelector('.mw'), strip = el.querySelector('.mc');
  const calls = new Map();              // id → call record, insertion order = age
  let tick = null, pop = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function packet(dir, cls) {
    if (reduced()) return;
    const p = document.createElement('span');
    p.className = `mp ${dir} ${cls}`;
    wire.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }

  function chipHTML(c) {
    const st = c.state, res = RES_WORD[st];
    const t = c.long || c.done ? `<span class="t">${fmt((c.endAt || o.now()) - c.at)}</span>` : '';
    return `${c.caller?.kind === 'sub' ? '<span class="sub">sub ·</span>' : ''}<span class="lbl">MCP</span>`
      + `<span class="srv">${esc(c.label || c.server)}</span><span class="vb">${esc(c.verb)}</span>${t}`
      + (res ? `<span class="res">${res}</span>` : '');
  }
  function tip(c) {
    const who = c.caller?.kind === 'sub' ? `sub-agent${c.caller.name ? ' ' + c.caller.name : ''}` : 'this agent';
    const res = RES_WORD[c.state] || 'running';
    const why = c.why ? (WHY_WORD[c.why] || c.why) : '';
    return `${c.label || c.server} · ${c.verb} · called by ${who} · ${fmt((c.endAt || o.now()) - c.at)} · ${res}${why ? ' · ' + why : ''}`;
  }
  function paint(c) {
    const compact = c.chip.classList.contains('is-compact');   // layout owns compactness; a repaint (the elapsed tick) must keep it
    c.chip.className = `mchip ${c.state}${c.settled ? ' is-settled' : ''}${compact ? ' is-compact' : ''}`;
    c.chip.innerHTML = chipHTML(c);
    c.chip.title = tip(c);
  }

  function layout() {
    const list = [...calls.values()].reverse();            // newest first
    el.classList.toggle('is-idle', !list.length);
    el.classList.toggle('is-long', list.some(c => c.long && !c.done));
    wire.classList.toggle('s-out', list.some(c => !c.done));
    strip.querySelector(':scope > .mmore')?.remove();
    list.forEach((c, i) => { if (c.chip.parentNode !== strip || strip.children[i] !== c.chip) strip.insertBefore(c.chip, strip.children[i] || null); c.chip.classList.toggle('is-compact', i > 0); });
    let shown = Math.min(list.length, o.maxChips);
    const apply = () => {
      list.forEach((c, i) => { c.chip.hidden = i >= shown; });
      strip.querySelector(':scope > .mmore')?.remove();
      const hid = list.slice(shown);
      if (hid.length) {
        const loud = RANK.find(r => hid.some(c => c.state === r && !c.settled)) || '';
        const m = document.createElement('button');
        m.type = 'button'; m.className = `mchip mmore ${loud}`; m.textContent = `+${hid.length}`;
        m.setAttribute('aria-label', `${hid.length} more MCP calls`); m.setAttribute('aria-haspopup', 'true');
        m.addEventListener('mouseenter', () => openPop(m, hid)); m.addEventListener('focus', () => openPop(m, hid));
        m.addEventListener('mouseleave', closePop); m.addEventListener('blur', closePop);
        strip.appendChild(m);
      }
    };
    /* fit at NATURAL width (chips can shrink, so without this the strip never
       overflows and the NEWEST gets squashed): fold older chips into +N first;
       the newest shrinks (verb, then server, ellipsised) only if it alone can't fit */
    strip.classList.add('is-measuring');
    /* the TITLE yields before the newest chip does: reserve the newest chip's natural
       width (+ the minimum wire and room for +N) as the indicator's minimum */
    el.style.minWidth = list.length ? `${list[0].chip.offsetWidth + 28 + (list.length > 1 ? 52 : 0)}px` : '';
    apply();
    while (shown > 1 && strip.scrollWidth > strip.clientWidth + 1) { shown--; apply(); }
    strip.classList.remove('is-measuring');
  }

  /* +N list: fixed-position, outside the bar (the bar clips), failures first */
  function openPop(anchor, hid) {
    closePop();
    const r = anchor.getBoundingClientRect();
    pop = document.createElement('div');
    pop.className = 'hwb-mcp-pop'; pop.setAttribute('role', 'tooltip');
    const rows = [...hid].sort((a, b) => RANK.indexOf(a.state) - RANK.indexOf(b.state));
    pop.innerHTML = rows.map(c => `<div class="mrow ${c.state}"><span class="dot"></span><span class="srv">${esc(c.label || c.server)}</span><span class="vb">${esc(c.verb)}</span>`
      + `<span class="who">${c.caller?.kind === 'sub' ? 'sub' + (c.caller.name ? ' · ' + esc(c.caller.name) : '') : 'agent'}</span>`
      + `<span class="t">${fmt((c.endAt || o.now()) - c.at)}</span><span class="res">${RES_WORD[c.state] || 'running'}</span></div>`).join('');
    document.body.appendChild(pop);
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    anchor.setAttribute('aria-expanded', 'true');
  }
  function closePop() { pop?.remove(); pop = null; strip.querySelector('.mmore')?.setAttribute('aria-expanded', 'false'); }

  function ensureTick() {
    const need = [...calls.values()].some(c => c.long && !c.done);
    if (need && !tick) tick = setInterval(() => { calls.forEach(c => { if (c.long && !c.done) paint(c); }); }, 1000);
    if (!need && tick) { clearInterval(tick); tick = null; }
  }

  function settle(c) {
    c.timers.push(setTimeout(() => { c.settled = true; paint(c); layout(); }, o.holdMs));
    c.timers.push(setTimeout(() => {
      c.chip.classList.add('is-gone');
      c.timers.push(setTimeout(() => { c.chip.remove(); calls.delete(c.id); layout(); }, 400));
    }, o.holdMs + o.dimMs));
  }

  function finish(c, state, why, ms) {
    if (!c || c.done) return;
    c.done = true; c.state = state; c.why = why; c.endAt = ms != null ? c.at + ms : o.now();
    c.timers.forEach(clearTimeout); c.timers = [];
    if (state !== 's-none') packet('back', state);
    paint(c); layout(); ensureTick(); settle(c);
  }

  return {
    el,
    start(id, call = {}) {
      if (calls.has(id)) return;
      const now = o.now(), at = Number.isFinite(call.ts) && call.ts <= now ? call.ts : now, age = now - at;
      const { result, why, ms, phase, ...rest } = call;          // a start event carries no result
      const c = { ...rest, id, at, state: 's-out', timers: [], chip: document.createElement('span') };
      calls.set(id, c);
      if (age >= o.longAfterMs) c.long = true;                   // a replayed long call shows as long at once
      paint(c); layout(); ensureTick();
      if (age < 2000) packet('out', 's-out');                   // a REPLAYED call doesn't send a second out packet
      if (!c.long) c.timers.push(setTimeout(() => { if (!c.done) { c.long = true; paint(c); layout(); ensureTick(); } }, o.longAfterMs - age));
      const limit = (c.expectEnd === false ? o.timeoutMs : o.staleMs) - age;
      c.timers.push(setTimeout(() => finish(c, 's-none', 'the server did not report an end'), Math.max(0, limit)));
    },
    end(id, r = {}) { finish(calls.get(id), RES_CLASS[r.result] || 's-ok', r.why, r.ms); },
    clear() { calls.forEach(c => { c.timers.forEach(clearTimeout); c.chip.remove(); }); calls.clear(); closePop(); layout(); ensureTick(); },
    destroy() { this.clear(); el.remove(); },
  };
}
