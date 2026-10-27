/* ROOM DOCUMENT VIEWER [ticket]: the preview column's viewer for markdown and
 * text files, after the knowledge-base web viewer (full screen, link, copy
 * contents, a ... menu with print / download / view source). Used by BOTH the
 * Assets panel's preview items (web/room-cells.mjs) and the sent-attachment
 * preview (web/room-attach.mjs). Images and every other file keep the old
 * preview: docKind() answers null for them.
 *
 * SECURITY. The room page holds the person's session and the text is written
 * by agents, so rendered markdown is untrusted HTML. It goes through DOMPurify
 * (vendored, pinned; web/vendor/dompurify/PROVENANCE.txt) with script, style,
 * iframe, object, embed, form, svg and every on* attribute forbidden, and then
 * through our own pass: a link keeps its href only for http(s) and mailto and
 * always opens in a new tab with rel=noopener noreferrer; an image keeps its
 * src only for https, a data:image png/jpeg/gif/webp, or this origin's
 * assets/raw route (a relative path resolves against the document's own URL);
 * any other image is replaced by its alt text. The result is a DOM fragment,
 * never a string that is parsed twice.
 *
 * marked + DOMPurify load lazily, on the first text preview, from web/vendor
 * (never a CDN: this runs offline). Source-only: no mermaid, no highlighting.
 *
 * Text arrives through a SAME-ORIGIN fetch with the person's cookie (the
 * engine's raw route for sent files). An Assets item's download/open URL is
 * fetched as the panel gave it; if the browser refuses (cross-origin without
 * CORS) the pane says so and offers Download. Capped at 2 MB.
 */

export const MAX_BYTES = 2 * 1024 * 1024;
const MD_EXT = /\.(md|markdown)$/i;
const CODE_EXT = /\.(json|csv|tsv|ya?ml|toml|xml|ini)$/i;
const TEXT_EXT = /\.(txt|log|text)$/i;

const ICON = {
  full: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

/** 'markdown' | 'text' (wrapped) | 'code' (not wrapped) | null = not ours.
 *  A room note is text; an image is never ours whatever its name says. */
export function docKind(name, type, note = false) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  const n = String(name || '').split(/[?#]/)[0];
  if (t.startsWith('image/')) {
    return null;
  }
  if (MD_EXT.test(n) || t === 'text/markdown' || t === 'text/x-markdown') {
    return 'markdown';
  }
  if (CODE_EXT.test(n) || t === 'application/json' || t === 'text/csv' || t === 'text/yaml' || t === 'application/yaml' || t === 'application/xml' || t === 'text/xml') {
    return 'code';
  }
  if (note || TEXT_EXT.test(n) || t === 'text/plain') {
    return 'text';
  }
  return null;
}

/* ---- the libraries, once, on the first text preview ---- */
let libs = null;
function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}
/** marked + DOMPurify. `?v=` is the pinned version: the files never change in place. */
export function loadLibs() {
  if (globalThis.marked && globalThis.DOMPurify) {
    return Promise.resolve({ marked: globalThis.marked, purify: globalThis.DOMPurify });
  }
  libs ??= Promise.all([addScript('/vendor/dompurify/purify.min.js?v=3.2.4'), addScript('/vendor/marked/marked.min.js?v=15.0.7')])
    .then(() => ({ marked: globalThis.marked, purify: globalThis.DOMPurify }))
    .catch((e) => {
      libs = null; // a later try may work
      throw e;
    });
  return libs;
}

const FORBID_TAGS = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas', 'dialog', 'template', 'noscript'];
const FORBID_ATTR = ['style', 'class', 'id', 'name', 'srcset', 'sizes', 'formaction', 'action', 'ping', 'background', 'poster', 'xlink:href'];
const DATA_IMG = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

/** An href that may stay: absolute http(s) or mailto. Everything else is dropped. */
export function safeHref(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}
/** An image src that may stay: https, a small set of data:image, or this
 *  origin's assets/raw route. `base` resolves a relative path. */
export function safeImgSrc(raw, base) {
  const s = String(raw).trim();
  if (DATA_IMG.test(s)) {
    return s;
  }
  try {
    const u = new URL(s, new URL(base || location.href, location.href));
    if (u.protocol === 'https:') {
      return u.href;
    }
    return u.origin === location.origin && u.pathname.includes('/assets/raw/') ? u.href : null;
  } catch {
    return null;
  }
}

/** Sanitize untrusted HTML into a DOM fragment. */
export function sanitizeHtml(purify, html, base) {
  const hook = (node) => {
    if (node.tagName === 'A') {
      const h = node.hasAttribute('href') ? safeHref(node.getAttribute('href')) : null;
      if (h) {
        node.setAttribute('href', h);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else {
        node.removeAttribute('href');
        node.removeAttribute('target');
      }
    } else if (node.tagName === 'IMG') {
      const s = node.hasAttribute('src') ? safeImgSrc(node.getAttribute('src'), base) : null;
      if (s) {
        node.setAttribute('src', s);
        node.setAttribute('referrerpolicy', 'no-referrer');
        node.setAttribute('loading', 'lazy');
      } else {
        const alt = node.getAttribute('alt');
        node.replaceWith(document.createTextNode(alt ? `[image: ${alt}]` : '[image]'));
      }
    }
  };
  purify.addHook('afterSanitizeAttributes', hook);
  try {
    return purify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  } finally {
    purify.removeHook('afterSanitizeAttributes', hook);
  }
}

/** Markdown text -> a sanitized DOM fragment. */
export function renderMarkdown(lib, text, base) {
  return sanitizeHtml(lib.purify, lib.marked.parse(text, { gfm: true, async: false }), base);
}

/** The document's text, capped. {text} | {tooLarge:true} | {error}. */
export async function fetchDoc(url, f = globalThis.fetch) {
  try {
    const r = await f(url, { credentials: 'same-origin' });
    if (!r.ok) {
      return { error: `HTTP ${r.status}` };
    }
    const len = Number(r.headers?.get?.('content-length'));
    if (len > MAX_BYTES) {
      return { tooLarge: true };
    }
    if (!r.body?.getReader) {
      const t = await r.text();
      return t.length > MAX_BYTES ? { tooLarge: true } : { text: t };
    }
    const rd = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) {
        break;
      }
      n += value.byteLength;
      if (n > MAX_BYTES) {
        rd.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return { text: new TextDecoder('utf-8').decode(all) };
  } catch (e) {
    return { error: e?.message || 'could not load' };
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}
function svgOf(key) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[key]; // constants above
  return s;
}
function tool(key, label, onClick) {
  const b = el('button', 'dv-tb');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(svgOf(key));
  b.addEventListener('click', onClick);
  return b;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

let sharedMenu = null;
async function menuHost() {
  sharedMenu ??= (await import('/room-seat-menu.mjs')).createMenuHost();
  return sharedMenu;
}

/**
 * One document. o: {name, type?, kind (docKind), url (fetch it), base?
 * (relative links resolve against it), ref? (what Link copies; default url),
 * downloadUrl?, downloadName?, menu? (a menu host: tests), fetchDoc?}
 * -> {body, tools, kind}: `body` goes in the column, `tools` in its header.
 */
export function createDocView(o) {
  const kind = o.kind;
  const body = el('div', 'dv');
  body.dataset.kind = kind;
  const tools = el('div', 'dv-tools');
  const live = el('span', 'dv-live');
  live.setAttribute('role', 'status');
  let state = null; // {text} | {tooLarge} | {error}
  let showSource = false;
  let lib = null;

  const dlUrl = o.downloadUrl || o.url;
  function download() {
    const a = document.createElement('a');
    a.href = dlUrl;
    a.setAttribute('download', o.downloadName || o.name || 'document');
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }
  function problem(why) {
    const p = el('div', 'dv-problem');
    p.append(el('p', '', why));
    const a = el('a', 'pv-btn pri', 'Download');
    a.href = dlUrl;
    a.setAttribute('download', o.downloadName || o.name || 'document');
    a.rel = 'noopener noreferrer';
    p.append(a);
    return p;
  }
  /** The document drawn into `host` (the column, the full-screen card, the print root). */
  function paint(host) {
    host.replaceChildren();
    if (!state) {
      host.append(el('p', 'dv-status', 'Loading…'));
    } else if (state.tooLarge) {
      host.append(problem('Too large to preview'));
    } else if (state.error) {
      host.append(problem(`Could not load this document (${state.error}).`));
    } else if (kind === 'markdown' && !showSource) {
      const d = el('div', 'dv-md');
      try {
        d.append(renderMarkdown(lib, state.text, o.base || o.url));
      } catch {
        d.append(el('pre', 'dv-pre', state.text)); // never blank: the text itself
      }
      host.append(d);
    } else {
      host.append(el('pre', `dv-pre${kind === 'code' && !showSource ? ' nowrap' : ''}`, state.text));
    }
  }
  const hosts = new Set([body]);
  const repaint = () => hosts.forEach(paint);

  function flash(btn, msg) {
    const was = btn.title;
    btn.classList.add('ok');
    btn.title = msg;
    live.textContent = msg;
    setTimeout(() => {
      btn.classList.remove('ok');
      btn.title = was;
      live.textContent = '';
    }, 1500);
  }

  /* ---- full screen: the same document in a modal over the page ---- */
  function openFull(opener) {
    const scrim = el('div', 'dv-scrim');
    const card = el('div', 'modal-card dv-lg');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', o.name);
    const h = el('div', 'dv-lg-h');
    h.append(el('span', 'dv-lg-t', o.name));
    const x = el('button', 'dv-tb dv-lg-x');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close full screen');
    x.append(svgOf('close'));
    h.append(x);
    const inner = el('div', 'dv dv-full');
    inner.dataset.kind = kind;
    card.append(h, inner);
    scrim.append(card);
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      hosts.delete(inner);
      scrim.remove();
      opener?.focus?.({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    x.addEventListener('click', close);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) {
        close();
      }
    });
    hosts.add(inner);
    paint(inner);
    document.body.append(scrim);
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
  }

  /* ---- print: only the rendered document, on its own root ---- */
  function print() {
    const root = el('div', 'dv-print-root');
    const inner = el('div', 'dv dv-printing');
    inner.dataset.kind = kind;
    root.append(inner);
    const wasSource = showSource;
    showSource = false; // the rendered view, as the KB does
    paint(inner);
    showSource = wasSource;
    document.body.append(root);
    const done = () => {
      document.documentElement.classList.remove('dv-printing');
      root.remove();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    document.documentElement.classList.add('dv-printing');
    setTimeout(() => window.print(), 50);
  }

  const bFull = tool('full', 'Full screen', () => openFull(bFull));
  const bLink = tool('link', 'Copy link', async () => flash(bLink, (await copyText(o.ref || new URL(o.url, location.href).href)) ? 'Link copied' : 'Could not copy'));
  const bCopy = tool('copy', 'Copy contents', async () => {
    if (state?.text !== undefined) {
      flash(bCopy, (await copyText(state.text)) ? 'Contents copied' : 'Could not copy');
    }
  });
  const bMore = tool('more', 'More options', async () => {
    const host = o.menu ?? (await menuHost());
    const items = [{ a: 'print', label: 'Print', icon: 'print', off: state?.text === undefined, why: 'Not loaded' }, { a: 'download', label: 'Download', icon: 'dl' }];
    if (kind === 'markdown') {
      items.push({ a: 'source', label: showSource ? 'View rendered' : 'View source', icon: showSource ? 'eye' : 'src', off: state?.text === undefined, why: 'Not loaded' });
    }
    bMore.setAttribute('aria-haspopup', 'menu');
    host.open({
      row: bMore,
      more: bMore,
      label: 'Document options',
      title: o.name,
      items,
      choose(it) {
        host.close();
        if (it.a === 'print') {
          print();
        } else if (it.a === 'download') {
          download();
        } else {
          showSource = !showSource;
          repaint();
        }
      },
      closed: (back, refocus) => {
        if (refocus) {
          bMore.focus({ preventScroll: true });
        }
      },
    });
  });
  bFull.classList.add('dv-full-btn'); // hidden on a phone: the preview already fills it
  tools.append(bFull, bLink, bCopy, bMore, live);

  paint(body);
  (async () => {
    if (kind === 'markdown') {
      try {
        lib = await (o.libs ?? loadLibs)();
      } catch {
        lib = null;
      }
    }
    const r = await (o.fetchDoc ?? fetchDoc)(o.url);
    state = r;
    repaint();
  })();

  return { body, tools, kind, text: () => state?.text, openFull, print };
}
