// The Image Viewer page: the glue between the host contract (host.js), the model (viewer-model.js) and the DOM.
// the design notes §16.3, the design's styleguide/mockups/workbench-image-markup. The column never blocks the message
// box: no scrim, no focus trap; the arrow keys, V P B, Delete, Esc and Ctrl+Z work only while focus is in this page.
// Everything drawn comes from the model's layout(): box lines in one SVG, pins, chips and handles as elements the
// page positions through CSSOM (the module CSP has no inline styles). The page is built once; render() updates it.

import { createBridge } from './bridge.js';
import { createViewer } from './viewer-model.js';
import { createHost } from './host.js';

const ROLE = /^--md-sys-color-[a-z-]{1,40}$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\(\s*-?[\d.]+%?(\s*[, ]\s*-?[\d.]+%?){2}(\s*[,/]\s*[\d.]+%?)?\s*\))$/;
const MAX_ROLES = 64;
const NS = 'http://www.w3.org/2000/svg';
const SAVE_FAILED = "Couldn't save the marks. They will save again in a moment, and on your next change.";
const LOAD_FAILED = "This picture couldn't be opened.";

const IC = {
  prev: '<path d="M15 6l-6 6 6 6"/>', next: '<path d="M9 6l6 6-6 6"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>', collapse: '<path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>',
  select: '<path d="M5 3l14 8-6 2-2 6z"/>', pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  box: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The host's theme: only --md-sys-color-* roles with plain colour values reach the page's style. */
export function applyTheme(root, vars) {
  if (!vars || typeof vars !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(vars)) {
    if (n >= MAX_ROLES) break;
    if (ROLE.test(k) && typeof v === 'string' && v.trim().length <= 40 && COLOR.test(v.trim())) {
      root.style.setProperty(k, v.trim());
      n++;
    }
  }
  return n;
}

export async function mountViewer({ doc, win = globalThis.window, bridge, host = createHost({ bridge }) }) {
  const app = doc.getElementById('app');
  let v = null; // the model, once the first picture is read
  let pictures = [];
  let sent = false;
  let notice = null; // a transient line in the footer's place: a refusal, a failed save, a failed read
  let noticeTimer = null;
  let nav = Promise.resolve();
  let el = null;
  const imgs = new Map(); // picture id -> {url, ok}

  const say = (text, ms = 4000) => {
    notice = text;
    clearTimeout(noticeTimer);
    if (text && ms) noticeTimer = setTimeout(() => { notice = null; render(); }, ms);
  };

  function build() {
    app.innerHTML = `<div class="vh"><button class="ib" data-a="prev" aria-label="Previous" title="Previous (←)">${icon('prev')}</button>
      <button class="ib" data-a="next" aria-label="Next" title="Next (→)">${icon('next')}</button><div class="t"></div>
      <button class="ib" data-a="exp" aria-label="Expand" title="Expand">${icon('expand')}</button>
      <button class="ib" data-a="close" aria-label="Close" title="Close (Esc)">${icon('close')}</button></div>
      <div class="vt"><div class="tg" role="group" aria-label="Tools">${[['select', 'Select', 'V'], ['pin', 'Pin', 'P'], ['box', 'Box', 'B']].map(([t, n, k]) =>
        `<button data-tool="${t}" aria-pressed="false" title="${n} (${k})">${icon(t)}${n}</button>`).join('')}</div><span class="sp"></span>
        <button class="ib" data-a="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button class="ib" data-a="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${icon('redo')}</button>
        <button class="ib" data-a="del" aria-label="Delete mark" title="Delete mark (Delete)">${icon('trash')}</button></div>
      <div class="stagep t-select"><img class="pic" alt=""><svg class="mk" aria-hidden="true"></svg><div class="items"></div>
        <div class="zb"><span class="zl"></span><button data-a="fit">Fit</button><button data-a="z100">100%</button></div></div>
      <div class="foot"></div>`;
    el = {
      title: app.querySelector('.vh .t'), stage: app.querySelector('.stagep'), img: app.querySelector('img.pic'), mk: app.querySelector('svg.mk'),
      items: app.querySelector('.items'), zoom: app.querySelector('.zl'), foot: app.querySelector('.foot'), exp: app.querySelector('[data-a=exp]'),
      tools: [...app.querySelectorAll('[data-tool]')], acts: Object.fromEntries([...app.querySelectorAll('[data-a]')].map((b) => [b.dataset.a, b])),
    };
  }

  const px = (n) => Math.round(n * 100) / 100 + 'px';
  function position(node, props) { for (const [k, val] of Object.entries(props)) node.style[k] = px(val); }

  function render() {
    if (!v || !el) return;
    const h = v.header();
    el.title.innerHTML = `${esc(h.name)} <small>· ${esc(h.position)}</small>`;
    el.title.title = h.title;
    el.acts.prev.disabled = !h.previous;
    el.acts.next.disabled = !h.next;
    const exp = v.expanded;
    el.acts.exp.setAttribute('aria-label', exp ? 'Collapse' : 'Expand');
    el.acts.exp.title = exp ? 'Collapse' : 'Expand';
    el.acts.exp.innerHTML = icon(exp ? 'collapse' : 'expand');
    const tools = v.tools();
    for (const b of el.tools) {
      const t = tools[b.dataset.tool];
      b.setAttribute('aria-pressed', String(t.pressed));
      b.disabled = t.disabled;
    }
    const ed = v.edits();
    el.acts.undo.disabled = !ed.undo; el.acts.redo.disabled = !ed.redo; el.acts.del.disabled = !ed.remove;
    el.stage.className = 'stagep t-' + v.interaction.tool;
    // the picture and its marks, in the stage's pixels
    const it = v.interaction, view = it.view, p = v.picture(), got = imgs.get(p.id);
    if (got && got.ok) {
      if (el.img.dataset.id !== p.id) { el.img.dataset.id = p.id; el.img.src = got.url; el.img.alt = p.name; }
      position(el.img, { left: view.ox, top: view.oy, width: view.image.width * view.scale, height: view.image.height * view.scale });
      el.img.hidden = false;
    } else {
      el.img.hidden = true;
    }
    const lay = v.layout();
    el.mk.replaceChildren(...lay.lines.map((l) => {
      const r = doc.createElementNS(NS, 'rect');
      r.setAttribute('class', l.cls); r.setAttribute('x', l.x); r.setAttribute('y', l.y); r.setAttribute('width', l.w); r.setAttribute('height', l.h);
      return r;
    }));
    el.items.replaceChildren(...lay.items.map((m) => {
      const n = doc.createElement('span');
      if (m.kind === 'pin') {
        n.className = 'pinm' + (m.wide ? ' wide' : '') + (m.selected ? ' sel' : '');
        n.innerHTML = `<b>${esc(m.label)}</b>`;
      } else if (m.kind === 'chip') {
        n.className = 'chipm' + (m.selected ? ' sel' : '');
        n.textContent = m.label;
      } else {
        n.className = 'hd';
        n.dataset.part = m.part;
      }
      position(n, { left: m.x, top: m.y });
      return n;
    }));
    el.zoom.textContent = v.zoomLabel();
    // the footer: a transient line first, then the model's lock line, then the tool's hint or the key chips
    const lock = v.notice();
    const hint = v.hint();
    if (notice) el.foot.innerHTML = `<div class="vnote warn" role="status">${esc(notice)}</div>`;
    else if (lock) el.foot.innerHTML = `<div class="vnote">${icon('lock')}<span>${esc(lock)}</span></div>`;
    else if (hint === 'keys') el.foot.innerHTML = '<div class="vf"><span class="k">V</span><span class="k">P</span><span class="k">B</span> tools · <span class="k">←</span><span class="k">→</span> pictures · <span class="k">Del</span> mark</div>';
    else if (hint) el.foot.innerHTML = `<div class="vf">${esc(hint)}</div>`;
    else el.foot.textContent = '';
  }

  const stageBox = () => ({ width: Math.max(1, el.stage.clientWidth), height: Math.max(1, el.stage.clientHeight) });

  /** Read one picture and its companion into the list's entry, once. A picture that cannot be read is shown as such. */
  async function ready(i) {
    const p = pictures[i];
    if (p.loaded) return p.loaded === 'ok';
    try {
      const r = await host.load(p);
      const im = new win.Image();
      im.src = r.dataUrl;
      await im.decode();
      p.width = im.naturalWidth; p.height = im.naturalHeight; p.companion = r.companion === null ? undefined : r.companion;
      imgs.set(p.id, { url: r.dataUrl, ok: true });
      p.loaded = 'ok';
    } catch (e) {
      p.width = p.width || 1; p.height = p.height || 1;
      p.companion = '\u0000unreadable'; // nothing may be written for a picture that was not read
      imgs.set(p.id, { url: '', ok: false });
      p.loaded = 'failed';
      say(LOAD_FAILED, 0);
    }
    return p.loaded === 'ok';
  }

  function start(list, from, isSent) {
    pictures = list;
    sent = isSent;
    return ready(from).then(() => {
      v = createViewer({
        pictures, start: from, box: stageBox(), sent,
        save: (id, text) => {
          const p = pictures.find((q) => q.id === id);
          void host.save(p, text, { onFail: () => { say(SAVE_FAILED, 0); render(); }, onOk: () => { if (notice === SAVE_FAILED) { say(null); } render(); } });
          void host.marks(id, v.counts()[pictures.indexOf(p)]);
        },
      });
      render();
    });
  }

  /** Move by one picture, reading it first (the model assumes a picture it opens has its size and companion). */
  function move(delta) {
    nav = nav.then(async () => {
      if (!v) return;
      const to = v.index + delta;
      if (to < 0 || to >= pictures.length) return;
      await ready(to);
      if (delta > 0) v.next(); else v.previous();
      say(null);
      render();
    });
    return nav;
  }

  // ---- events
  const stagePoint = (e) => { const r = el.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const answer = (r) => { if (r && r.ok === false && r.notice) say(r.notice); render(); };
  function onKey(e) {
    if (!v || (e.target && e.target.closest && e.target.closest('textarea,input,[contenteditable]'))) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === '<') { e.preventDefault(); void move(-1); return; }
    if (k === 'ArrowRight' || k === '>') { e.preventDefault(); void move(1); return; }
    const r = v.key(e);
    if (r && r.request === 'close') { e.preventDefault(); void host.dismiss(); return; }
    if (r && (r.ok || r.notice)) e.preventDefault();
    answer(r);
  }
  function onClick(e) {
    const b = e.target && e.target.closest && e.target.closest('[data-a],[data-tool]');
    if (!b || !v) return;
    if (b.dataset.tool) { answer(v.interaction.setTool(b.dataset.tool)); return; }
    const a = b.dataset.a;
    const it = v.interaction;
    if (a === 'prev') void move(-1);
    else if (a === 'next') void move(1);
    else if (a === 'close') { v.close(); void host.dismiss(); }
    else if (a === 'exp') { v.setExpanded(!v.expanded); void host.expand(v.expanded); render(); }
    else if (a === 'undo') answer(it.key({ key: 'z', ctrlKey: true }));
    else if (a === 'redo') answer(it.key({ key: 'z', ctrlKey: true, shiftKey: true }));
    else if (a === 'del') answer(it.key({ key: 'Delete' }));
    else if (a === 'fit') { it.fit(); render(); }
    else if (a === 'z100') { it.actual(); render(); }
  }

  build();
  app.addEventListener('keydown', onKey);
  app.addEventListener('click', onClick);
  el.stage.addEventListener('pointerdown', (e) => {
    if (!v || e.button !== 0 || (e.target.closest && e.target.closest('.zb'))) return; // the zoom buttons are theirs
    e.preventDefault(); // keep focus in the viewer; a redraw would replace what is under the pointer
    app.focus({ preventScroll: true });
    try { el.stage.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer */ }
    const p = stagePoint(e);
    answer(v.interaction.pointerDown(p.x, p.y));
  });
  el.stage.addEventListener('pointermove', (e) => { if (!v || !(e.buttons & 1)) return; const p = stagePoint(e); answer(v.interaction.pointerMove(p.x, p.y)); });
  const up = (e) => { if (!v) return; const p = stagePoint(e); answer(v.interaction.pointerUp(p.x, p.y)); };
  el.stage.addEventListener('pointerup', up);
  el.stage.addEventListener('pointercancel', (e) => { if (v) v.key({ key: 'Escape' }); render(); void e; });
  el.stage.addEventListener('wheel', (e) => { if (!v) return; e.preventDefault(); const p = stagePoint(e); v.interaction.wheel(e.deltaY, p.x, p.y); render(); }, { passive: false });
  if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => { if (v) { v.resize(stageBox()); render(); } }).observe(el.stage);
  win.addEventListener('pagehide', () => { if (v) v.close(); });

  bridge.on('theme', (vars) => applyTheme(doc.documentElement, vars));
  bridge.on('image.state', (s) => {
    const list = s && Array.isArray(s.pictures) ? s.pictures : null;
    if (!list) return;
    void host.init().then(({ pictures: next, start: from, sent: isSent }) => { if (v) v.close(); v = null; return start(next, from, isSent); }).catch(() => {});
  });

  try {
    const init = await host.init();
    await start(init.pictures, init.start, init.sent);
  } catch (e) {
    app.innerHTML = `<p class="err" role="alert">${esc(e && e.code === 'bad-list' ? "The picture list couldn't be read." : "This view couldn't start. Close it and open the picture again.")}</p>`;
  }
  return { render, get model() { return v; }, move };
}

// In the page itself (not under tests): wire the real bridge.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById && document.getElementById('app') && !window.__wbImageViewerTest) {
  const bridge = createBridge(window);
  void mountViewer({ doc: document, win: window, bridge });
}
