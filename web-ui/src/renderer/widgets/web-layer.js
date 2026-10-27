// Widgets in the web build, the in-window layer (the owner ; the design notes W1, W2, W4, W5 carried over,
// W3 dropped). The host draws each widget's chrome: a header strip that is the drag handle (pointer capture) and
// moves with the arrow keys when focused, the title, a ✕, and a right-click menu (Close, and Wide/Tall when the
// widget declares both). The module draws the content in a sandboxed frame through the frame link
// (module-frame.js: declared, nonce hello, one port). A frame's requests go to the model's two verbs with the
// widget's key from THIS record, never from the frame. Positions are set through CSSOM (the app CSP allows no
// inline style attributes). web-model.js holds every number; this file only draws and wires events.
// test/widget-web-layer.test.mjs.
//
// deps: doc · root (the layer element, over the app content) · model (web-model.js) · makeLink (createFrameLink)
//       entry(moduleId) → catalog entry · uiUrl(entry, page) → URL · declare(url, owner) → Promise<bool>
//       theme() → roles object · onChange() → the header list re-reads its rows

export const HEADER_H = 28;

export function createWidgetLayer(deps) {
  const { doc, root, model } = deps;
  const views = new Map(); // key → { el, frameBox, link }
  let seq = 0;
  let menu = null;

  const px = (n) => Math.round(n) + 'px';
  function layout(key) {
    const v = views.get(key), w = model.widget(key);
    if (!v || !w) return;
    v.el.style.left = px(w.pos.x);
    v.el.style.top = px(w.pos.y);
    v.el.style.width = px(w.size.w);
    v.frameBox.style.height = px(w.size.h);
  }
  const changed = () => { try { deps.onChange?.(); } catch { /* the list's own error */ } };

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }
  function openMenu(key, x, y) {
    closeMenu();
    const w = model.widget(key);
    if (!w) return;
    menu = doc.createElement('div');
    menu.className = 'wbw-menu';
    menu.setAttribute('role', 'menu');
    const item = (label, fn) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'wbw-mi';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); fn(); });
      menu.appendChild(b);
    };
    item('Close', () => close(key));
    if (w.sizes.wide && w.sizes.tall) {
      for (const s of ['wide', 'tall']) if (s !== w.shape) item(s === 'wide' ? 'Wide' : 'Tall', () => shape(key, s));
    }
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    menu.style.left = px(x);
    menu.style.top = px(y);
    root.appendChild(menu);
    menu.firstChild?.focus?.();
  }

  function shape(key, s) {
    const w = model.setShape(key, s);
    if (!w) return false;
    layout(key);
    views.get(key)?.link.post({ event: 'surface', payload: { kind: 'widget', shape: w.shape, node: w.node } });
    return true;
  }

  function reply(link, id, r) {
    if (!Number.isSafeInteger(id)) return;
    link.post(r && r.ok === true ? { id, ok: true, body: r.body ?? null } : { id, ...(r || { ok: false, kind: 'transport' }), ok: false });
  }

  function mount(w) {
    const entry = deps.entry(w.moduleId);
    const el = doc.createElement('section');
    el.className = 'wbw';
    el.setAttribute('aria-label', w.title);
    const head = doc.createElement('div');
    head.className = 'wbw-h';
    head.tabIndex = 0;
    head.setAttribute('aria-roledescription', 'draggable widget header');
    const title = doc.createElement('span');
    title.className = 'wbw-t';
    title.textContent = w.title;
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'wbw-x';
    x.setAttribute('aria-label', 'Close ' + w.title);
    x.textContent = '✕';
    x.addEventListener('click', () => close(w.key));
    head.appendChild(title);
    head.appendChild(x);
    const frameBox = doc.createElement('div');
    frameBox.className = 'wbw-b';
    el.appendChild(head);
    el.appendChild(frameBox);

    const key = w.key;
    const owner = 'widget:' + key + '.' + (++seq);
    const link = deps.makeLink({
      doc, src: deps.uiUrl(entry, w.page).href, owner, title: w.title,
      declare: deps.declare,
      onConnect: () => {
        const cur = model.widget(key);
        if (!cur) return;
        link.post({ event: 'surface', payload: { kind: 'widget', shape: cur.shape, node: cur.node } });
        link.post({ event: 'theme', payload: deps.theme() });
      },
      onMessage: (m) => {
        if (!m || typeof m !== 'object' || typeof m.verb !== 'string') return;
        const before = model.widget(key)?.shape;
        void model.call(key, m.verb, m.input).then((r) => {
          if (r && r.ok === true && m.verb === 'shape' && model.widget(key)?.shape !== before) {
            layout(key);
            link.post({ event: 'surface', payload: { kind: 'widget', shape: r.body.shape, node: w.node } });
          }
          reply(link, m.id, r);
          if (r && r.kind === 'revoked') close(key);
        }, () => reply(link, m.id, { ok: false, kind: 'transport' }));
      },
      onClose: () => {},
    });
    link.frame.className = 'wbw-f';
    frameBox.appendChild(link.frame);

    // drag: pointer capture on the header; the ✕ is not a handle
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === x) return;
      const cur = model.widget(key);
      if (!cur) return;
      drag = { id: e.pointerId, dx: e.clientX - cur.pos.x, dy: e.clientY - cur.pos.y };
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault?.();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      model.moveTo(key, { x: e.clientX - drag.dx, y: e.clientY - drag.dy });
      layout(key);
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      head.releasePointerCapture?.(e.pointerId);
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    head.addEventListener('keydown', (e) => {
      if (e.target !== head) return;
      if (model.key(key, e.key, e.shiftKey)) {
        layout(key);
        e.preventDefault?.();
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        const cur = model.widget(key);
        if (cur) openMenu(key, cur.pos.x, cur.pos.y + HEADER_H);
        e.preventDefault?.();
      }
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault?.();
      openMenu(key, e.clientX, e.clientY);
    });

    root.appendChild(el);
    views.set(key, { el, frameBox, link });
    layout(key);
  }

  function close(key) {
    const v = views.get(key);
    model.close(key);
    if (v) {
      views.delete(key);
      v.link.close();
      v.el.remove();
    }
    closeMenu();
    changed();
  }

  return Object.freeze({
    /** From the header list: open (or focus) one widget. → the model's answer. */
    open(a) {
      const r = model.open(a);
      if (!r.ok) return r;
      if (!views.has(r.widget.key)) {
        mount(r.widget);
        changed();
      }
      return r;
    },
    close,
    closeAll() {
      for (const key of [...views.keys()]) close(key);
      model.closeAll();
    },
    shape,
    /** The layer's element changed size (a ResizeObserver or the window's resize). */
    resize(size) {
      for (const w of model.resize(size)) layout(w.key);
    },
    /** The catalog changed: close what is no longer listed; the modules' frames end. */
    sync() {
      for (const key of model.sync()) close(key);
      changed();
    },
    /** The theme changed: every open widget hears it. */
    theme() {
      const roles = deps.theme();
      for (const v of views.values()) v.link.post({ event: 'theme', payload: roles });
    },
    openKeys: () => [...views.keys()],
  });
}
