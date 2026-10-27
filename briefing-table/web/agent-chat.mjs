/* AGENT CHAT [agent chat] Owner 2026-10-05 (room Briefing Table room interface [ref]-[ref]).
 *
 * A session window for an agent CLI has two views of the SAME session: CLI (the
 * terminal, unchanged) and Chat (this file): the agent's own conversation as
 * bubbles, your message box, attachments, and the agent's Scratchpad. The
 * source is the engine's GET /api/sessions/:paneid/chat (the transcript), never
 * "only what the agent posts". Sending goes through the room typer
 * (POST .../chat), so a held draft is never typed over.
 *
 * Switching views never touches the session: the terminal stays mounted and is
 * only hidden (solo.js), so nothing detaches, reattaches or respawns.
 *
 * Look: the room's bubble vocabulary (.entry / .entry-bubble / .rm-compose ...,
 * agent-chat.css restates room.css's rules under .ac because room.css owns the
 * whole page and cannot be loaded into the solo window).
 *
 * The pure rules live in agent-chat-core.mjs (unit-tested); this is the DOM. Every throw in an async
 * handler is caught and shown inline, never swallowed.
 */
import { linkNodes } from '/room-links.mjs';
import { ensureMarkdown, onMarkdownReady, renderLineMarkdown } from '/room-line-markdown.mjs'; // the agent's replies as Markdown [line markdown]
import { openExternal } from '/open-external.mjs';
import { hasChatTabs, pendingLabel, echoes, toolLine, splitFences, fromPeer } from '/agent-chat-core.mjs';
export { AGENT_VENDORS, hasChatTabs, viewKey, readView, writeView, pickView } from '/agent-chat-core.mjs';
import { isHidden, onVisibility } from '/page-visibility.mjs';
import { lineTime } from '/time-format.mjs'; // the room line's clock [time format]
import { openSearch } from '/search-ui.mjs'; // search this conversation [search ui]
import { youGlyph } from '/you-settings.mjs'; // YOUR picture / initial / person icon, the room's own glyph
import { onEnterSubmits, attachSendMenu, enterAction } from '/enter-pref.mjs';
import { voiceGlyph } from '/room-voice.mjs'; // [concierge] the voice mark on a line the person spoke

const fmtTime = lineTime; // the room line's own formatter (web/time-format.mjs), so the two cannot drift

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(inner, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  if (cls) {
    s.setAttribute('class', cls);
  }
  s.innerHTML = inner; // constants only
  return s;
}
const PLUS = '<path d="M12 5v14M5 12h14"/>';
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
};
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) {
    return '';
  }
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** A readable message from a failed reply. */
async function whyNot(res) {
  try {
    const b = await res.json();
    return b.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * The chat view.
 * @param {{paneid:string, agentName:()=>string, agentGlyph:()=>Node, onTyped?:()=>void, onOpenCli?:()=>void}} o
 */
export function createChat(o) {
  const base = `/api/sessions/${encodeURIComponent(o.paneid)}`;
  const root = el('section', 'ac');
  root.id = 'agentChat';
  root.hidden = true;
  root.setAttribute('aria-label', 'Chat with the agent');
  root.innerHTML = `
    <div class="ac-main">
      <div class="ac-bar"><span class="ac-bar-sp"></span>
        <button type="button" class="ac-search" id="acSearch" title="Search this conversation (Ctrl+F)" aria-label="Search this conversation" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"/></svg></button>
        <button type="button" class="ac-padbtn" id="acPadBtn" aria-pressed="false" title="The agent's files">Scratchpad</button></div>
      <div class="rm-scroll ac-scroll" id="acScroll">
        <button type="button" class="rm-older" id="acOlder" hidden>load older</button>
        <p class="rm-start" id="acStart" hidden>start of the conversation</p>
        <div class="ac-notice" id="acNotice" hidden></div>
        <ol class="rm-entries ac-list" id="acList"></ol>
        <button type="button" class="ac-newer" id="acNewer" hidden><span class="nw">New messages</span><b class="nc">1</b><span class="ar" aria-hidden="true">\u2193</span></button>
      </div>
      <p class="ac-err" id="acErr" role="status" hidden></p>
      <div class="rm-compose ac-compose" id="acCompose" role="form" aria-label="Message the agent">
        <div class="ac-tray" id="acTray" hidden></div>
        <button type="button" class="rm-attach" id="acAttach" title="Attach files to the Scratchpad" aria-label="Attach files">PLUSSVG</button>
        <input type="file" id="acFile" multiple hidden />
        <div class="rm-inputwrap"><textarea id="acInput" rows="1" placeholder="Message the agent" spellcheck="false" autocomplete="off" autocapitalize="sentences" aria-label="Message the agent"></textarea></div>
        <button type="button" class="rm-send" id="acSend" aria-label="Send" title="Send">&rarr;</button>
      </div>
    </div>
    <aside class="ac-padcol" id="acPad" aria-label="Scratchpad" hidden>
      <div class="ac-pad-h"><b>Scratchpad</b><span class="ac-pad-sp"></span>
        <button type="button" class="ac-pad-up" id="acPadUp">Upload</button>
        <button type="button" class="ac-pad-x" id="acPadX" aria-label="Close the Scratchpad">&times;</button></div>
      <p class="ac-pad-note" id="acPadNote"></p>
      <ul class="ac-pad-list" id="acPadList"></ul>
      <input type="file" id="acPadFile" multiple hidden />
    </aside>`;
  const q = (id) => root.querySelector(`#${id}`);
  const attachBtn = q('acAttach');
  attachBtn.replaceChildren(svg(PLUS));
  const scroller = q('acScroll');
  const list = q('acList');
  const input = q('acInput');
  const sendBtn = q('acSend');
  const tray = q('acTray');
  const errEl = q('acErr');

  const items = new Map(); // id -> item, in arrival order
  const locals = []; // [concierge voice] lines only this page holds (a test turn): drawn among the items by time, never sent
  let before = null; // cursor for older pages
  let latest = null; // cursor for the tail
  let supported = null;
  let loaded = false;
  let visible = false;
  let timer = null;
  let polling = false;
  let enterSubmits = true;
  let me = null; // GET /api/rooms/me {name, picture}: your glyph beside your bubbles (null = the generic person icon)
  const pending = []; // {key, text, files, state, held, error, ts}
  const draftFiles = []; // {name, state:'up'|'ok'|'err', error}
  let seq = 0;

  void ensureMarkdown();
  queueMicrotask(() => onMarkdownReady(() => paint(false))); // after createChat has finished (paint reads consts declared below): lines drawn plain while the libraries loaded are drawn again
  const say = (msg) => {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  };

  /* ---- rendering ---- */
  function bodyNodes(text) {
    const wrap = el('div', 'entry-body');
    const md = renderLineMarkdown(text); // Markdown, sanitized (null: no markup, or the libraries are not loaded yet: the plain path below)
    if (md) {
      wrap.append(...md);
      return wrap;
    }
    for (const run of splitFences(text)) {
      if (run.code) {
        const pre = el('pre', 'ac-code');
        pre.append(el('code', '', run.text));
        wrap.append(pre);
      } else {
        wrap.append(...linkNodes(run.text));
      }
    }
    return wrap;
  }
  /* [concierge] wb: links the engine resolved as it served the page: a chip for a live
     one (o.onLink opens it: a new shell tab on a desktop, this tab on a phone), the
     link and why for a dead one, never a chip that leads nowhere */
  function linkChips(links) {
    const row = el('div', 'ac-wb');
    for (const l of links) {
      if (l.ok) {
        const b = el('button', 'ac-wb-chip', l.label || l.href);
        b.type = 'button';
        b.title = l.href;
        b.addEventListener('click', () => {
          try {
            if (o.onLink) {
              o.onLink(l);
            } else {
              location.href = l.url;
            }
          } catch (e) {
            b.title = `Could not open: ${e?.message ?? e}`;
          }
        });
        row.append(b);
      } else {
        row.append(el('span', 'ac-wb-dead', `${l.href}: ${l.note || 'not available'}`));
      }
    }
    return row;
  }
  function fileChips(files) {
    const row = el('div', 'ac-files');
    for (const f of files) {
      const a = el('a', 'ac-file', f.name);
      a.href = `${base}/scratchpad/raw/${encodeURIComponent(f.name)}`;
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        openExternal(new URL(a.href, location.href).href);
      });
      row.append(a);
    }
    return row;
  }
  /** A search hit's author: a snippet that kept the engine's typed prefix names its sender [chat sender]. */
  function authorOfHit(r) {
    if (r.role !== 'user') {
      return o.agentName();
    }
    const peer = fromPeer({ role: 'user', text: (r.snippet ?? []).map((x) => x.t).join('') });
    return peer ? '@' + peer.from : 'you';
  }
  function rowFor(it, prev) {
    const li = el('li');
    li.dataset.id = it.id;
    if (it.role === 'tool') {
      li.className = 'entry by-room ac-tool';
      li.append(el('span', 'entry-body', toolLine(it)));
      return li;
    }
    if (it.role === 'system') {
      li.className = 'entry by-room';
      li.append(el('span', 'entry-body', it.text));
      return li;
    }
    /* [chat sender] a typed turn the ENGINE delivered for another agent or a room is theirs, not yours */
    const peer = fromPeer(it);
    if (peer) {
      li.className = 'entry by-agent ac-peer';
      const glyph = el('span', 'entry-glyph ac-peer-glyph', '@');
      glyph.setAttribute('aria-hidden', 'true');
      const bubble = el('div', 'entry-bubble');
      const head = el('div', 'entry-head');
      head.append(el('span', 'entry-author', '@' + peer.from));
      head.append(el('span', 'ac-peer-via', peer.via === 'room' ? `in ${peer.room}` : `direct${peer.kind ? ' ' + peer.kind : ''}`));
      if (it.ts) {
        head.append(el('span', 'entry-ts', fmtTime(it.ts)));
      }
      bubble.append(head, bodyNodes(peer.body));
      li.append(glyph, bubble);
      return li;
    }
    const mine = it.role === 'user';
    li.className = `entry ${mine ? 'by-user' : 'by-agent'}${prev && prev.role === it.role && !fromPeer(prev) ? ' same' : ''}`;
    const glyph = el('span', 'entry-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.append(mine ? youGlyph(me) : o.agentGlyph());
    const bubble = el('div', 'entry-bubble');
    const head = el('div', 'entry-head');
    head.append(el('span', mine ? 'entry-author rm-sr' : 'entry-author', mine ? 'you' : o.agentName()));
    if (it.meta?.via === 'voice') {
      const v = voiceGlyph('mic', 14);
      v.classList.add('ac-voice');
      v.setAttribute('aria-hidden', 'false');
      v.setAttribute('role', 'img');
      v.setAttribute('aria-label', 'voice');
      head.append(v, el('span', 'ac-voice-word', 'voice'));
    }
    if (it.meta?.test) {
      head.append(el('span', 'ac-test', 'test'));
    }
    if (it.ts) {
      head.append(el('span', 'entry-ts', fmtTime(it.ts)));
    }
    bubble.append(head, bodyNodes(it.text));
    if (it.files?.length) {
      bubble.append(fileChips(it.files));
    }
    if (it.links?.length) {
      bubble.append(linkChips(it.links));
    }
    li.append(glyph, bubble);
    return li;
  }
  function pendingRow(p) {
    const li = el('li', 'entry by-user ac-pending');
    li.dataset.pending = p.key;
    const glyph = el('span', 'entry-glyph');
    glyph.append(youGlyph(me));
    const bubble = el('div', 'entry-bubble');
    bubble.append(bodyNodes(p.text || ''));
    if (p.files.length) {
      bubble.append(fileChips(p.files.map((name) => ({ name }))));
    }
    const st = el('div', 'entry-reads ac-state', p.error ? p.error : pendingLabel(p.state, p.held));
    st.dataset.state = p.error ? 'failed' : p.state;
    li.append(glyph, bubble, st);
    if (p.error) {
      li.title = 'Click to dismiss';
      li.addEventListener('click', () => {
        const i = pending.indexOf(p);
        if (i >= 0) {
          pending.splice(i, 1);
        }
        paint(false);
      });
    }
    return li;
  }
  /** Repaint the whole list (a page of 50 plus a tail is small).
   *  THE ROOM LINE'S SCROLLING RULES [chat scroll] (Owner 2026-10-06: the chat opened at the top): land on the newest message on
   *  open and on every switch back; new lines keep it pinned to the bottom only while it IS at the bottom; scrolled up, never
   *  jump, and offer "New messages ↓"; loading older keeps your place. `added` = how many lines this repaint brought in. */
  let stickUntil = 0;
  let pinned = true; // at the bottom, as the person left it (a hidden view stays pinned: it has no position yet)
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); // after layout (code blocks, images)
  };
  const newer = q('acNewer');
  let newCount = 0; // lines that arrived while scrolled up
  const hideNewer = () => {
    newer.hidden = true;
    newCount = 0;
  };
  const showNewer = (n) => {
    newCount += n;
    newer.querySelector('.nw').textContent = newCount > 1 ? 'New messages' : 'New message';
    newer.querySelector('.nc').textContent = newCount > 99 ? '99+' : String(newCount);
    newer.hidden = false;
  };
  function paint(stick, added = 0) {
    const keepTop = scroller.scrollTop;
    const keepFrom = scroller.scrollHeight - scroller.scrollTop;
    const follow = stick === true || Date.now() < stickUntil || (stick !== 'older' && (pinned || (scroller.clientHeight > 0 && atBottom())));
    const frag = document.createDocumentFragment();
    let prev = null;
    let li = 0;
    const put = (it) => {
      frag.append(rowFor(it, prev));
      prev = it.role === 'tool' || it.role === 'system' ? null : it;
    };
    for (const it of items.values()) {
      while (li < locals.length && locals[li].ts < it.ts) {
        put(locals[li++]);
      }
      put(it);
    }
    while (li < locals.length) {
      put(locals[li++]);
    }
    for (const p of pending) {
      frag.append(pendingRow(p));
    }
    list.replaceChildren(frag);
    q('acOlder').hidden = before == null;
    q('acStart').hidden = !(loaded && supported && before == null && items.size > 0);
    if (stick === 'older') {
      scroller.scrollTop = scroller.scrollHeight - keepFrom;
    } else if (follow) {
      pinned = true;
      hideNewer();
      toBottom();
    } else {
      scroller.scrollTop = keepTop; // scrolled up: never jump
      if (added > 0) {
        showNewer(added);
      }
    }
  }
  function notice(text, withCli) {
    const n = q('acNotice');
    n.replaceChildren();
    n.hidden = !text;
    if (!text) {
      return;
    }
    n.append(el('p', '', text));
    if (withCli) {
      const b = el('button', 'ac-opencli', 'Open the CLI');
      b.type = 'button';
      b.addEventListener('click', () => o.onOpenCli?.());
      n.append(b);
    }
  }

  /* ---- data ---- */
  async function getPage(qs) {
    const res = await fetch(`${base}/chat?${qs}`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(await whyNot(res));
    }
    return res.json();
  }
  function takePage(p, mode) {
    if (p.supported === false) {
      supported = false;
      items.clear();
      notice(p.reason || 'this conversation cannot be shown', true);
      before = null;
      latest = null;
      return;
    }
    supported = true;
    notice(p.note || '', false);
    if (p.reset) {
      items.clear();
    }
    if (mode === 'older') {
      /* older pages go in FRONT of what we have */
      const merged = new Map();
      for (const it of p.items) {
        merged.set(it.id, it);
      }
      for (const [id, it] of items) {
        merged.set(id, it);
      }
      items.clear();
      for (const [id, it] of merged) {
        items.set(id, it);
      }
      before = p.before;
      return;
    }
    for (const it of p.items) {
      items.set(it.id, it);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (echoes(it, pending[i])) {
          pending.splice(i, 1);
        }
      }
    }
    if (mode === 'first' || p.reset) {
      before = p.before;
    }
    if (p.latest != null) {
      latest = p.latest;
    }
  }
  /** First load. Returns {supported, reason} so the window can pick its default view. */
  async function load() {
    try {
      const p = await getPage('limit=50');
      takePage(p, 'first');
      loaded = true;
      paint(true);
      say('');
      return { supported: p.supported !== false, reason: p.reason };
    } catch (e) {
      say(`Could not load the conversation: ${e.message}`);
      return { supported: null, reason: e.message };
    }
  }
  async function loadOlder(limit = 50) {
    if (before == null) {
      return;
    }
    try {
      const p = await getPage(`limit=${limit}&before=${encodeURIComponent(before)}`);
      takePage(p, 'older');
      paint('older');
    } catch (e) {
      say(`Could not load older messages: ${e.message}`);
    }
  }
  async function poll() {
    if (polling || !visible || isHidden() || supported === false || !loaded) {
      return;
    }
    polling = true;
    try {
      const p = await getPage(latest != null ? `after=${encodeURIComponent(latest)}` : 'limit=50');
      const had = items.size;
      takePage(p, 'tail');
      if (p.items.length || p.reset || pending.length || items.size !== had) {
        paint(false, Math.max(0, items.size - had));
      }
      say('');
    } catch (e) {
      say(`Chat is not updating: ${e.message}`);
    } finally {
      polling = false;
    }
  }
  function schedule() {
    clearInterval(timer);
    timer = visible ? setInterval(() => void poll(), 2000) : null;
  }
  onVisibility(() => {
    if (visible && !isHidden()) {
      void poll();
    }
  });

  /* ---- sending ---- */
  async function loadEnter() {
    try {
      const res = await fetch('/api/rooms/me', { cache: 'no-store' });
      if (res.ok) {
        const m = await res.json();
        const had = me ? `${me.picture ?? ''}|${me.name ?? ''}` : null;
        me = { name: m.name, picture: m.picture };
        if (had !== `${me.picture ?? ''}|${me.name ?? ''}` && items.size + pending.length) {
          paint(false); // the avatar arrived after the first rows
        }
        const v = m.enterSubmits ?? m.enter_submits;
        if (typeof v === 'boolean') {
          enterSubmits = v;
        }
      }
    } catch {
      /* the default (Enter sends) stands */
    }
  }
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, Math.round(innerHeight * 0.3))}px`;
  }
  function busy() {
    return draftFiles.some((f) => f.state === 'up');
  }
  function syncSend() {
    const ready = draftFiles.filter((f) => f.state === 'ok').length;
    sendBtn.disabled = busy() || draftFiles.some((f) => f.state === 'err') || (!input.value.trim() && !ready);
  }
  function paintTray() {
    tray.replaceChildren();
    tray.hidden = draftFiles.length === 0;
    for (const f of draftFiles) {
      const chip = el('span', `ac-chip is-${f.state}`);
      chip.append(el('span', 'ac-chip-n', f.name));
      chip.append(el('span', 'ac-chip-s', f.state === 'up' ? 'uploading' : f.state === 'err' ? f.error || 'failed' : ''));
      const x = el('button', 'ac-chip-x', String.fromCharCode(215));
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${f.name}`);
      x.addEventListener('click', () => {
        draftFiles.splice(draftFiles.indexOf(f), 1);
        paintTray();
        syncSend();
      });
      chip.append(x);
      tray.append(chip);
    }
  }
  /** POST one file to the Scratchpad; resolves to the stored name. */
  async function uploadOne(file) {
    const res = await fetch(`${base}/scratchpad`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      throw new Error(await whyNot(res));
    }
    return (await res.json()).name;
  }
  async function addDraftFiles(files) {
    for (const file of files) {
      const f = { name: file.name, state: 'up', error: '' };
      draftFiles.push(f);
      paintTray();
      syncSend();
      try {
        f.name = await uploadOne(file);
        f.state = 'ok';
      } catch (e) {
        f.state = 'err';
        f.error = e.message;
      }
      paintTray();
      syncSend();
    }
    refreshPad().catch(() => {});
  }
  async function send() {
    if (sendBtn.disabled) {
      return;
    }
    const text = input.value.trim();
    const files = draftFiles.filter((f) => f.state === 'ok').map((f) => f.name);
    const p = { key: `p${++seq}`, text, files, state: 'sending', held: null, error: '', ts: Date.now() };
    pending.push(p);
    stickUntil = Date.now() + 8000; // your own message stays in view while it goes in and echoes
    input.value = '';
    draftFiles.length = 0;
    paintTray();
    grow();
    syncSend();
    paint(true);
    o.onTyped?.();
    try {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, files: files.length ? files : undefined }),
      });
      if (!res.ok) {
        p.error = `not sent: ${await whyNot(res)}`;
      } else {
        const b = await res.json();
        p.state = b.state || 'typed';
        p.held = b.held || (b.reason ? { reason: b.reason } : null);
      }
    } catch (e) {
      p.error = `not sent: ${e.message}`;
    }
    paint(false);
    void poll();
  }

  /* ---- the Scratchpad ---- */
  const pad = q('acPad');
  async function refreshPad() {
    const note = q('acPadNote');
    const ul = q('acPadList');
    try {
      const res = await fetch(`${base}/scratchpad`, { cache: 'no-store' });
      if (!res.ok) {
        note.textContent = await whyNot(res);
        ul.replaceChildren();
        return;
      }
      const b = await res.json();
      note.textContent = b.files.length ? '' : 'No files yet. Upload one for the agent, or wait for it to save some here.';
      ul.replaceChildren(
        ...b.files.map((f) => {
          const li = el('li');
          const a = el('a', 'ac-pad-file', f.name);
          a.href = f.raw;
          a.addEventListener('click', (ev) => {
            ev.preventDefault();
            openExternal(new URL(a.href, location.href).href);
          });
          li.append(a, el('small', '', [fmtSize(f.size), f.addedAt ? fmtTime(f.addedAt) : ''].filter(Boolean).join(' - ')));
          return li;
        }),
      );
    } catch (e) {
      note.textContent = `Could not read the Scratchpad: ${e.message}`;
    }
  }
  function togglePad(open) {
    pad.hidden = !open;
    root.classList.toggle('pad-open', open);
    q('acPadBtn').setAttribute('aria-pressed', String(open));
    if (open) {
      void refreshPad();
    }
  }

  /* ---- wiring ---- */
  let lastTop = 0;
  scroller.addEventListener('scroll', () => {
    if (scroller.clientHeight > 0) { // a hidden view has no position to remember
      pinned = atBottom();
      if (pinned) {
        hideNewer();
      }
    }
    /* only a move UP near the top: a repaint or the jump to the bottom is not a request for history */
    const up = scroller.scrollTop < lastTop;
    lastTop = scroller.scrollTop;
    if (up && lastTop < 40 && before != null && loaded) {
      void loadOlder();
    }
  });
  q('acOlder').addEventListener('click', () => void loadOlder());
  newer.addEventListener('click', () => {
    pinned = true;
    hideNewer();
    toBottom();
  });
  /* SEARCH THIS CONVERSATION [search ui] (Owner 2026-10-06; the design system §1.K; engine GET /api/sessions/:paneid/chat/search): every word,
     newest first; `more` = the scan stopped at its page budget, so older history was not searched. A pick makes sure the message
     is on the page by loading older history until it is (the list must stay contiguous, so no skipping ahead), then centres it
     in THIS scroller and flashes it. */
  async function jumpTo(id) {
    for (let guard = 0; !items.has(id) && before != null && guard < 60; guard++) {
      await loadOlder(200);
    }
    const li = [...list.children].find((x) => x.dataset.id === id);
    if (!li) {
      say('That message is no longer in the history that can be shown.');
      return;
    }
    pinned = false; // the jump is a place to read, not the bottom: nothing snaps back
    hideNewer();
    const delta = li.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (scroller.clientHeight - li.offsetHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: Math.abs(delta) > scroller.clientHeight * 4 ? 'auto' : 'smooth' });
    li.classList.remove('is-found');
    void li.offsetWidth;
    li.classList.add('is-found');
    setTimeout(() => li.classList.remove('is-found'), 2400);
  }
  function openChatSearch() {
    openSearch({
      anchor: q('acSearch'),
      title: 'Search this conversation',
      placeholder: 'Search this conversation…',
      hint: "Search this conversation's whole history…",
      recentKey: 'hwb.search.recent.chat',
      fetch: async (qs, signal) => {
        const res = await fetch(`${base}/chat/search?q=${encodeURIComponent(qs)}&limit=50`, { cache: 'no-store', signal });
        if (!res.ok) {
          throw new Error(await whyNot(res));
        }
        const b = await res.json();
        return {
          results: (b.results ?? []).map((r) => ({ key: r.id, author: authorOfHit(r), time: r.ts, place: '', parts: r.snippet })),
          more: !!b.more,
        };
      },
      onPick: (r) => void jumpTo(r.key),
    });
  }
  q('acSearch').addEventListener('click', openChatSearch);
  document.addEventListener('keydown', (ev) => {
    if (visible && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'f' && !COARSE) {
      ev.preventDefault();
      openChatSearch();
    }
  });
  /* the view was hidden when it loaded (a background tab) or its content grew after the jump (images, code): while pinned, stay on
     the newest */
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (pinned && visible && scroller.clientHeight > 0 && !atBottom()) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }).observe(list);
  }
  input.addEventListener('input', () => {
    grow();
    syncSend();
  });
  /* the SAME key rule as the room (web/enter-pref.mjs enterAction, Owner 2026-10-05) */
  const phoneInput = () => matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 600px)').matches;
  input.addEventListener('keydown', (ev) => {
    const act = enterAction(ev, enterSubmits, phoneInput());
    if (act === 'newline') {
      ev.preventDefault();
      input.setRangeText(String.fromCharCode(10), input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (act === 'send') {
      ev.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener('click', () => void send());
  attachBtn.addEventListener('click', () => q('acFile').click());
  q('acFile').addEventListener('change', (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    void addDraftFiles(files);
  });
  q('acPadBtn').addEventListener('click', () => togglePad(pad.hidden));
  q('acPadX').addEventListener('click', () => togglePad(false));
  q('acPadUp').addEventListener('click', () => q('acPadFile').click());
  q('acPadFile').addEventListener('change', (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    (async () => {
      for (const f of files) {
        try {
          await uploadOne(f);
        } catch (e) {
          q('acPadNote').textContent = `${f.name}: ${e.message}`;
        }
      }
      await refreshPad();
    })().catch((e) => {
      q('acPadNote').textContent = e.message;
    });
  });
  void loadEnter();
  /* [enter pref] Owner 2026-10-05: live (no reload) and a Send context menu; note() is the inline line the view already has */
  onEnterSubmits((v) => { enterSubmits = v; });
  let noteTimer = 0;
  attachSendMenu(sendBtn, {
    get: () => enterSubmits,
    note: (t, kind) => {
      errEl.textContent = t;
      errEl.hidden = false;
      errEl.style.color = kind === 'error' ? '' : 'var(--dim)';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { errEl.hidden = true; errEl.style.color = ''; }, 4000);
    },
  });
  syncSend();

  return {
    el: root,
    load,
    /** Show or hide the view; showing starts the 2 s tail and (on a mouse device) focuses the box. */
    setVisible(v) {
      visible = v;
      root.hidden = !v;
      schedule();
      if (v) {
        void loadEnter();
        if (loaded) {
          void poll();
        } else {
          void load();
        }
        if (!COARSE) {
          input.focus();
        }
        pinned = true; // switching to Chat always lands on the newest message
        hideNewer();
        toBottom();
      }
    },
    get supported() {
      return supported;
    },
    /** [concierge voice] Show a line this page holds (a test turn: never sent, gone on reload).
     *  `it` = {role: 'user'|'assistant', text, meta?}; it lands at the bottom, stamped now. */
    addLocal(it) {
      locals.push({ ...it, id: `local-${locals.length + 1}`, ts: Date.now() });
      paint(true, 1);
    },
    /** The agent's name or ring changed: repaint the left bubbles' glyphs and names only (the scroll stays put). */
    repaint() {
      for (const g of list.querySelectorAll('.entry.by-agent > .entry-glyph')) {
        g.replaceChildren(o.agentGlyph());
      }
      for (const n of list.querySelectorAll('.entry.by-agent .entry-author')) {
        n.textContent = o.agentName();
      }
    },
  };
}

/* ==== THE VIEW TABS in the session bar ================================
 * the design system session bar (hwbRenderSessionBar, vendored, never edited) has no
 * slot for them, so they are ours, drawn after each render exactly the way the
 * mic is (voice-mic.mjs): ONE element for the page's life, re-attached after the
 * title, dispatching a bubbling `hwb:view` (detail.view) on the bar so the
 * standalone bar and the shell-drawn bar route it the same way (the shell
 * forwards it as {hwbBarAction:'view:chat'|'view:cli'}). */
export const VIEW_EVENT = 'hwb:view';

export function createViewTabs() {
  const box = document.createElement('div');
  box.className = 'sb-view';
  box.setAttribute('role', 'tablist');
  box.setAttribute('aria-label', 'Chat or CLI');
  box.style.setProperty('app-region', 'no-drag');
  box.style.setProperty('-webkit-app-region', 'no-drag');
  for (const [view, label] of [['chat', 'Chat'], ['cli', 'CLI']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = view;
    b.setAttribute('role', 'tab');
    b.textContent = label;
    b.addEventListener('click', () => b.dispatchEvent(new CustomEvent(VIEW_EVENT, { bubbles: true, detail: { view } })));
    box.append(b);
  }
  return box;
}

/**
 * @param {HTMLElement} bar  the `.hwb-sbar`, AFTER hwbRenderSessionBar and attachMic
 * @param {HTMLElement} box  the one element from createViewTabs()
 * @param {{view:'chat'|'cli', note?:string}|null} st  null = a shell or the command bridge: no tabs
 */
export function attachViewTabs(bar, box, st) {
  if (!bar || !box) {
    return;
  }
  if (!st) {
    box.remove();
    return;
  }
  for (const b of box.querySelectorAll('button')) {
    const on = b.dataset.view === st.view;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
    b.title = b.dataset.view === 'chat' && st.note ? st.note : b.dataset.view === 'chat' ? 'Chat with the agent' : 'The terminal';
  }
  /* right after the title: the right-hand side is the brand watermark and the icons */
  const title = bar.querySelector('.sb-title');
  if (title) {
    title.after(box);
  } else {
    bar.prepend(box);
  }
}
