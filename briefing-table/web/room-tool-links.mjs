/* LINE LINKS INTO A TOOL VIEW [rooms/tool-links] (Owner via alpha-platform:
 * design reviews run inside room apps; a line links to an app's view instead
 * of an HTML table in chat). Engine: src/engine/tool-links.ts. A line's
 * meta.links = [{tool, ref, label, view_path, panel_id}]; view_path is
 * relative to the app panel's frame, the same `path` a {panel:'preview',
 * view} takes.
 *
 * ONE LINK = THE CHIP (the design system): a button in the bubble under the body, after
 * any attachments: the tool's panel icon (14px, the room accent) + the label
 * (12.5px, ellipsised ~28 chars; the full label + the tool in the tooltip).
 * TWO OR MORE = THE LIST (the design system, phase 2): one inset box, rows divided by
 * hairlines; a caption "<Tool> · n items" when every link is one tool (mixed
 * tools: an icon per row instead). A row = thumb · #n · label · state. More
 * than 4: 4, then "Show n more". The rows draw at once from the line's own
 * data; only the thumb and the state wait for the app's "@meta" batch
 * (GET <frame>/<links_meta>?refs=a,b through the panel frame proxy, cached
 * 30 s per line, re-fetched when the line scrolls into view and on a room
 * refresh). A batch that fails or takes over ~4 s leaves label-only rows —
 * never an error in the bubble.
 *
 * INTERACTION (chip and row alike): click -> the room's PREVIEW COLUMN shows
 * the view (cells.openLink); Shift / Cmd / Ctrl-click -> LARGE; right-click,
 * Shift+F10 / the Menu key, a long press -> the seat-menu component: Open in
 * preview · Open large · Copy link (a phone drops Open large; a disabled link
 * keeps only Copy link). COPY LINK = the room URL + `#line-<id>~<tool>:<ref>`:
 * the existing line link (room-reply openHash jumps to it) plus the ref; this
 * module opens the view once the line is there.
 *
 * AVAILABILITY IS DERIVED HERE (the engine stores the link and never updates
 * it): from the room's panels (cells.list(): app_slug, app_held) and the app
 * catalog (GET /api/apps: status, rooms). Disabled, never hidden, with the
 * reason in engine words: "<Tool> isn't in this room any more" · "<Tool> is
 * in "<room>" now" · "Not running" · "Changed — needs approval".
 */
import { createMenuHost } from '/room-seat-menu.mjs';
import { toast as roomToast } from '/room-toast.mjs';
import { cleanPath, viewUrl } from '/room-cells.mjs';

const PHONE = '(max-width: 600px)';
const SHOW = 4;
const META_TTL_MS = 30000;
const META_WAIT_MS = 4000;
const LONG_PRESS_MS = 500;
const NOTE_MAX = 120;
const DASH = String.fromCharCode(8212);
const STATES = { waiting: 'Waiting', replied: 'Replied', resolved: 'Resolved' };

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

/** [app supersede] Owner 2026-10-05: the slug that answers a stored link's tool.
 *  An unregistered app that names a successor (GET /api/apps `superseded_by`)
 *  is answered by it when the successor is registered and approved; otherwise
 *  the stored slug, refused exactly as before. Stored lines are never rewritten. */
export function effectiveTool(tool, cat) {
  const app = cat?.get(tool);
  const to = app?.status === 'unregistered' && app.superseded_by ? cat.get(app.superseded_by.slug) : null;
  return to && to.status !== 'unregistered' && to.status !== 'held' ? to.slug : tool;
}

/** A line entry's stored links, shape-checked (meta is the engine's JSON). */
export function linksOf(e) {
  let m = null;
  try {
    m = typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta;
  } catch {
    m = null;
  }
  const a = m && Array.isArray(m.links) ? m.links : [];
  return a.filter((l) => l && typeof l.tool === 'string' && typeof l.ref === 'string' && typeof l.label === 'string' && typeof l.view_path === 'string');
}

/** "#2" from a ref whose last segment is a number, else ''. */
function numOf(ref) {
  const last = ref.split('/').pop() ?? '';
  return /^[0-9]{1,6}$/.test(last) ? `#${last}` : '';
}

/** One @meta item, cleaned: every field TEXT or a cleanPath-checked path. */
function cleanItem(it) {
  const note = typeof it.note === 'string' ? it.note.replace(/[\r\n]+/g, ' ').trim().slice(0, NOTE_MAX) : '';
  return {
    state: typeof it.state === 'string' && Object.prototype.hasOwnProperty.call(STATES, it.state) ? it.state : null,
    thumb: typeof it.thumb === 'string' ? cleanPath(it.thumb) : null,
    stale: it.stale === 'gone' ? 'gone' : it.stale === true || it.stale === 'superseded' ? 'superseded' : null,
    note,
  };
}

/**
 * @param {{roomId: string, cells: () => object|null, catalog: () => Map|null,
 *          iconSvg: (key: string|null) => Element}} o
 *   cells: room-cells' API (list, openLink); catalog: slug -> GET /api/apps
 *   entry, or null before it has loaded; iconSvg: a panel icon by KEY.
 */
export function mountToolLinks(o) {
  const menu = createMenuHost();
  const groups = new Map(); // entry id -> group
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((list) => {
      for (const x of list) {
        const g = x.target.__tlGroup;
        if (g) {
          g.visible = x.isIntersecting;
          if (g.visible) {
            fetchMeta(g);
          }
        }
      }
    })
    : null;

  /* ---- availability ---- */
  function panelFor(link) {
    const list = o.cells()?.list() ?? [];
    const tool = effectiveTool(link.tool, o.catalog());
    return list.find((p) => p.id === link.panel_id && p.app_slug === tool) ?? list.find((p) => p.app_slug === tool) ?? null;
  }
  /** {ok, why, name, icon, panel, meta}; `whole` = the reason is the tool's
   *  (the list says it once, in its caption). */
  function availability(link) {
    const cat = o.catalog();
    const app = cat?.get(effectiveTool(link.tool, cat)) ?? null;
    const panel = panelFor(link);
    const name = app?.name || panel?.title || link.tool;
    const base = { name, icon: app?.icon ?? panel?.icon ?? null, panel, meta: typeof app?.links_meta === 'string' ? app.links_meta : null };
    if (cat && !app) {
      return { ...base, ok: false, why: `${name} isn't in this room any more` };
    }
    if (app?.status === 'held' || panel?.app_held) {
      return { ...base, ok: false, why: `Changed ${DASH} needs approval` };
    }
    if (app?.status === 'unregistered' || panel?.app_status === 'unregistered') {
      return { ...base, ok: false, why: 'Not registered' }; // [ticket]
    }
    if (app && Array.isArray(app.rooms) && !app.rooms.some((r) => (r.ids || [r.id]).includes(o.roomId))) {
      const other = app.rooms[0];
      return { ...base, ok: false, why: other ? `${name} is in "${other.name}" now` : `${name} isn't in this room any more` };
    }
    if (!panel || app?.status === 'down') {
      return { ...base, ok: false, why: 'Not running' };
    }
    return { ...base, ok: true, why: '' };
  }

  /* ---- open / copy ---- */
  function open(link, big, opener) {
    const av = availability(link);
    if (!av.ok) {
      return false;
    }
    return !!o.cells()?.openLink({ panelId: av.panel.id, path: link.view_path, title: link.label, opener, large: big && !matchMedia(PHONE).matches });
  }
  function linkUrl(entryId, link) {
    const u = new URL(location.href);
    u.hash = `line-${entryId}~${link.tool}:${link.ref}`;
    return u.toString();
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
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
  function toast(text) {
    roomToast(text, { ms: 1500 }); // the one toast (hub v2)
  }

  function openMenu(g, link, btn, point) {
    const av = availability(link);
    const phone = matchMedia(PHONE).matches;
    const off = btn.getAttribute('aria-disabled') === 'true';
    const items = off
      ? [{ a: 'copy', label: 'Copy link', icon: 'link' }]
      : [
        { a: 'preview', label: 'Open in preview', icon: 'preview' },
        ...(phone ? [] : [{ a: 'large', label: 'Open large', icon: 'expand', k: 'Shift+click' }]),
        { a: 'copy', label: 'Copy link', icon: 'link' },
      ];
    menu.open({
      row: btn,
      point,
      label: `${link.label} link`,
      title: link.label,
      sub: av.name,
      data: { menu: 'toollink' },
      items,
      choose(it) {
        menu.close(false);
        if (it.a === 'preview' || it.a === 'large') {
          open(link, it.a === 'large', btn);
        } else if (it.a === 'copy') {
          void copy(linkUrl(g.id, link)).then((ok) => toast(ok ? 'Link copied' : 'Could not copy'));
          btn.focus({ preventScroll: true });
        }
      },
      closed(back, refocus) {
        if (refocus) {
          back?.row?.focus({ preventScroll: true });
        }
      },
    });
  }

  /** Click, the context menu, the menu keys and a long press on one link. */
  function wire(g, link, btn) {
    btn.dataset.tlKey = `${link.tool}:${link.ref}`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (btn.__tlLong) {
        btn.__tlLong = false;
        return; // the click that ends a long press
      }
      if (btn.getAttribute('aria-disabled') === 'true') {
        return;
      }
      open(link, ev.shiftKey || ev.metaKey || ev.ctrlKey, btn);
    });
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // the line's own menu stays shut
      openMenu(g, link, btn, { x: ev.clientX, y: ev.clientY });
    });
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(g, link, btn, null);
      }
    });
    let timer = 0;
    let at = null;
    btn.addEventListener('pointerdown', (ev) => {
      btn.__tlLong = false;
      if (ev.pointerType !== 'touch') {
        return;
      }
      at = { x: ev.clientX, y: ev.clientY };
      timer = setTimeout(() => {
        timer = 0;
        btn.__tlLong = true;
        openMenu(g, link, btn, at);
      }, LONG_PRESS_MS);
    });
    const cancel = () => {
      clearTimeout(timer);
      timer = 0;
    };
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointermove', (ev) => {
      if (timer && at && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 10) {
        cancel();
      }
    });
  }

  /* ---- the chip (one link) ---- */
  function chipBox(g) {
    const box = el('div', 'tl-chips');
    const link = g.links[0];
    const b = el('button', 'tl-chip');
    b.type = 'button';
    const ic = el('span', 'tl-ic');
    ic.setAttribute('aria-hidden', 'true');
    const lab = el('span', 'tl-lab', link.label);
    b.append(ic, lab);
    wire(g, link, b);
    box.append(b);
    g.rows.push({ el: b, link, ic });
    return box;
  }

  /* ---- the list (two or more) ---- */
  function listBox(g) {
    const box = el('div', 'tl-list');
    box.setAttribute('role', 'group');
    const one = g.links.every((l) => l.tool === g.links[0].tool);
    g.one = one;
    box.classList.toggle('tl-mixed', !one);
    if (one) {
      const cap = el('div', 'tl-cap');
      g.cap = { el: cap, ic: el('span', 'tl-ic'), text: el('span', 'tl-capt') };
      g.cap.ic.setAttribute('aria-hidden', 'true');
      cap.append(g.cap.ic, g.cap.text);
      box.append(cap);
    }
    g.links.forEach((link, i) => {
      const b = el('button', 'tl-row');
      b.type = 'button';
      const ic = one ? null : el('span', 'tl-ic');
      ic?.setAttribute('aria-hidden', 'true');
      const th = el('span', 'tl-th');
      th.setAttribute('aria-hidden', 'true');
      const num = numOf(link.ref);
      const n = el('span', 'tl-n', num);
      n.hidden = !num;
      const shown = num && link.label.startsWith(`${num} `) ? link.label.slice(num.length + 1) : link.label;
      const lab = el('span', 'tl-lab', shown);
      const st = el('span', 'tl-st');
      b.append(...(ic ? [ic] : []), th, n, lab, st);
      b.hidden = i >= SHOW;
      wire(g, link, b);
      box.append(b);
      g.rows.push({ el: b, link, ic, th, lab, st });
    });
    if (g.links.length > SHOW) {
      const more = el('button', 'tl-more', `Show ${g.links.length - SHOW} more`);
      more.type = 'button';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        for (const r of g.rows) {
          r.el.hidden = false;
        }
        more.remove();
        g.rows[SHOW]?.el.focus({ preventScroll: true });
      });
      box.append(more);
    }
    return box;
  }

  function paintIcon(slot, key) {
    if (slot && slot.dataset.key !== String(key)) {
      slot.dataset.key = String(key);
      slot.replaceChildren(o.iconSvg(key));
    }
  }

  function paintState(r, item, loading) {
    r.st.replaceChildren();
    r.st.className = 'tl-st';
    if (item?.stale && item.note) {
      r.st.classList.add('tl-note');
      r.st.textContent = item.note;
    } else if (item?.state) {
      r.st.classList.add(`s-${item.state}`);
      r.st.append(el('i', 'tl-dot'), el('span', '', STATES[item.state]));
    } else if (loading) {
      r.st.classList.add('tl-sk');
    }
  }

  function paintThumb(r, item, av, loading) {
    const want = item?.thumb && av.panel ? viewUrl(av.panel.frameUrl, item.thumb) : '';
    const img = r.th.querySelector('img');
    r.th.classList.toggle('tl-sk', !want && loading);
    if (want) {
      if (!img || img.dataset.src !== want) {
        const im = document.createElement('img');
        im.alt = '';
        im.loading = 'lazy';
        im.referrerPolicy = 'no-referrer';
        im.dataset.src = want;
        im.src = want;
        im.addEventListener('error', () => im.remove(), { once: true });
        r.th.replaceChildren(im);
      }
    } else if (img) {
      img.remove();
    }
  }

  /** Repaint one line's links from what is known now. */
  function paint(g) {
    let groupWhy = '';
    const avs = g.rows.map((r) => availability(r.link));
    if (g.one && avs.length && !avs[0].ok) {
      groupWhy = avs[0].why;
    }
    g.el.classList.toggle('is-off', !!groupWhy);
    if (g.cap) {
      paintIcon(g.cap.ic, avs[0]?.icon ?? null);
      g.cap.text.textContent = `${avs[0]?.name ?? ''} ${String.fromCharCode(183)} ${g.links.length} items${groupWhy ? ` ${String.fromCharCode(183)} ${groupWhy}` : ''}`;
      g.cap.el.title = groupWhy;
    }
    g.rows.forEach((r, i) => {
      const av = avs[i];
      const item = g.meta.get(`${r.link.tool}|${r.link.ref}`) ?? null;
      const gone = item?.stale === 'gone';
      const off = !av.ok || gone;
      r.el.setAttribute('aria-disabled', String(off));
      r.el.classList.toggle('is-off', off);
      r.el.classList.toggle('is-stale', !!item?.stale);
      r.el.title = !av.ok ? av.why : gone ? item.note || 'Gone' : `${r.link.label} ${String.fromCharCode(183)} ${av.name}`;
      paintIcon(r.ic, av.icon);
      if (r.th) {
        const hasMeta = av.ok && !!av.meta;
        const loading = hasMeta && !g.metaDone && !g.metaFailed;
        paintThumb(r, item, av, loading);
        /* label-only (no batch, or it failed / was too slow): no thumb slot;
           after a good batch an item without a thumb keeps an empty one, so
           the #n column stays aligned */
        r.th.hidden = !r.th.querySelector('img') && !loading && (!hasMeta || !g.metaDone);
        paintState(r, item, loading);
      }
    });
  }

  /* ---- the @meta batch ---- */
  function fetchMeta(g, force = false) {
    if (g.links.length < 2 || g.fetching || !g.el.isConnected || (!force && Date.now() - g.metaAt < META_TTL_MS)) {
      return;
    }
    const byTool = new Map();
    for (const l of g.links) {
      byTool.set(l.tool, [...(byTool.get(l.tool) ?? []), l]);
    }
    const jobs = [];
    for (const [tool, links] of byTool) {
      const av = availability(links[0]);
      const path = av.ok && av.meta ? cleanPath(av.meta) : null;
      if (path === null) {
        continue;
      }
      const url = viewUrl(av.panel.frameUrl, path);
      const refs = links.slice(0, 8).map((l) => encodeURIComponent(l.ref)).join(',');
      jobs.push({ tool, url: `${url}${url.includes('?') ? '&' : '?'}refs=${refs}` });
    }
    if (!jobs.length) {
      return;
    }
    g.metaAt = Date.now();
    const timer = setTimeout(() => {
      if (!g.metaDone) {
        g.metaFailed = true; // too slow: label-only rows (a late answer still fills in)
        paint(g);
      }
    }, META_WAIT_MS);
    g.fetching = Promise.all(jobs.map(async (j) => {
      const r = await fetch(j.url, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) {
        throw new Error(String(r.status));
      }
      const body = await r.json();
      for (const it of Array.isArray(body?.items) ? body.items : []) {
        if (it && typeof it === 'object' && typeof it.ref === 'string') {
          g.meta.set(`${j.tool}|${it.ref}`, cleanItem(it));
        }
      }
    }))
      .then(() => {
        g.metaDone = true;
        g.metaFailed = false;
      })
      .catch(() => {
        g.metaFailed = !g.metaDone; // a failed refetch keeps what an earlier one said
      })
      .finally(() => {
        clearTimeout(timer);
        g.fetching = null;
        paint(g);
      });
  }

  /** A line's links, under its body and after any attachments. */
  function decorate(li, bubble, e) {
    const links = linksOf(e);
    if (!links.length) {
      return;
    }
    const g = { id: e.id, links, rows: [], meta: new Map(), metaAt: 0, metaDone: false, metaFailed: false, fetching: null, visible: false, one: true, cap: null, el: null };
    g.el = links.length === 1 ? chipBox(g) : listBox(g);
    g.el.__tlGroup = g;
    const old = groups.get(e.id);
    if (old) {
      io?.unobserve(old.el);
      g.meta = old.meta; // a re-drawn line keeps what its batch said
      g.metaAt = old.metaAt;
      g.metaDone = old.metaDone;
    }
    groups.set(e.id, g);
    bubble.append(g.el);
    li.classList.add('has-tl');
    paint(g);
    if (links.length > 1) {
      io?.observe(g.el);
    }
  }

  /** The panels or the catalog moved: repaint every drawn line; re-fetch a
   *  visible list's batch when its cache is older than 30 s. */
  function refresh() {
    for (const [id, g] of groups) {
      if (!g.el.isConnected) {
        io?.unobserve(g.el);
        groups.delete(id);
        continue;
      }
      paint(g);
      if (g.visible) {
        fetchMeta(g);
      }
    }
  }

  /** A copied link (#line-<id>~<tool>:<ref>): once that line is drawn, open
   *  the view (room-reply's openHash does the jump). */
  function openHash() {
    const m = /^#line-([0-9]+)~([a-z0-9-]+):(.+)$/.exec(location.hash);
    if (!m) {
      return;
    }
    const id = Number(m[1]);
    const key = `${m[2]}:${decodeURIComponent(m[3])}`;
    const t0 = Date.now();
    const tick = () => {
      const g = groups.get(id);
      const r = g?.rows.find((x) => `${x.link.tool}:${x.link.ref}` === key);
      if (r && r.el.isConnected && o.cells()?.list().length !== undefined) {
        if (!open(r.link, false, r.el)) {
          r.el.focus({ preventScroll: true }); // unavailable: land on it, its tooltip says why
        }
        return;
      }
      if (Date.now() - t0 < 8000) {
        setTimeout(tick, 150);
      }
    };
    tick();
  }
  addEventListener('hashchange', openHash);

  return { decorate, refresh, openHash, availability, menuOpen: () => menu.isOpen() };
}
