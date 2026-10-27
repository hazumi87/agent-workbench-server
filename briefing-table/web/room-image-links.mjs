/* IMAGE LINKS IN ROOM LINES (Owner 2026-09-28): a line whose body links to an
 * IMAGE shows it inline, as a thumbnail under the body (after the line's
 * attachments, before the tool-link chips); a tap opens it full size in the
 * room's own lightbox (#lightbox — the same one room-cells.mjs opens for a
 * panel; room-cells owns its close: a tap anywhere or Esc).
 *
 * WHICH URLS: every URL room-links.mjs already makes a link (findUrls), whose
 * PATH ends in .png .jpg .jpeg .gif .webp .avif (any case; the query and hash
 * do not count). The text link stays in the body; the thumbnail is extra.
 *
 * PRIVACY: an <img> is a fetch, and a fetch tells the host Owner's address and
 * that he read the line. So a thumbnail is drawn ONLY for a trusted host
 * (trustedImageHost, the one list); any other URL stays a plain link and is
 * never requested.
 *
 * AGENT-SHARE: the room page is https behind Serve and agent-share is plain
 * http, so a direct <img> there is mixed content. A share URL for THIS room's
 * own asset folder is therefore drawn through the engine's raw route (the one
 * the attachments use); any other share file is tried directly and, if the
 * browser refuses it, its thumbnail quietly goes away like any failed image.
 * The share origin and the room's folder come from GET .../assets/folder,
 * fetched once, and only when a line holds a /raw/ image URL on a host the
 * page cannot already vouch for.
 *
 * Layout reuses room-attach.css (the design system A1): one image = the single-image box,
 * 2-4 = tiles, more = the first 4 and a "+N" tile. Text only: every name is
 * textContent; the only src is a URL that passed the checks above.
 */
import { findUrls } from '/room-links.mjs';
import { openExternal } from '/open-external.mjs';
import { openGallery } from '/room-lightbox-nav.mjs';

export const IMAGE_SHOW_MAX = 4;
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

/** The URL when `raw` is an absolute http(s) URL whose path names an image
 *  file, else null. */
export function imageUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return null;
  }
  return IMAGE_PATH_RE.test(u.pathname) ? u : null;
}

/** 100.64.0.0/10: the tailnet's CGNAT range (100.64.x.x - 100.127.x.x). */
function isTailnetIp(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) {
    return false;
  }
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/**
 * THE TRUSTED-HOST LIST: the only hosts an inline preview may load from.
 * Everything else stays a text link and is never fetched (privacy: an
 * external image fetch reveals Owner's IP and that he read the line).
 *   - this page's own origin (the engine);
 *   - the agent-share origin (`shareOrigin`, from .../assets/folder);
 *   - any *.ts.net host (the tailnet's MagicDNS names);
 *   - a 100.64.0.0/10 address (the tailnet's IPs).
 */
export function trustedImageHost(u, { pageOrigin = location.origin, shareOrigin = null } = {}) {
  if (u.origin === pageOrigin || (shareOrigin && u.origin === shareOrigin)) {
    return true;
  }
  const host = u.hostname.toLowerCase();
  return host.endsWith('.ts.net') || isTailnetIp(host);
}

/** The image URLs in a line body, in order, each once. Pure. */
export function imageUrlsIn(text) {
  const s = String(text ?? '');
  const seen = new Set();
  const out = [];
  for (const { start, end } of findUrls(s)) {
    const u = imageUrl(s.slice(start, end));
    if (u && !seen.has(u.href)) {
      seen.add(u.href);
      out.push(u);
    }
  }
  return out;
}

/** The file name a URL shows (its alt and caption): the last path segment. */
export function imageName(u) {
  const last = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * @param {{roomId: string, lightbox: () => HTMLElement | null}} o
 */
export function mountImageLinks(o) {
  let share = null; // {origin, folder} once known; false when it could not be read
  let shareP = null;

  function loadShare() {
    shareP ??= fetch(`/api/rooms/${encodeURIComponent(o.roomId)}/assets/folder`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const u = b && typeof b.shareUrl === 'string' ? new URL(b.shareUrl) : null;
        share = u && typeof b.folder === 'string' ? { origin: u.origin, folder: b.folder } : false;
      })
      .catch(() => {
        share = false;
      });
    return shareP;
  }

  /** What the <img> loads: this room's own share file through the engine's
   *  raw route (no mixed content, the page's own credential); else the URL. */
  function srcFor(u) {
    if (share && u.origin === share.origin) {
      const prefix = `/raw/${share.folder.split('/').map(encodeURIComponent).join('/')}/`;
      const rest = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : '';
      if (rest && !rest.includes('/')) {
        let name = rest;
        try {
          name = decodeURIComponent(rest);
        } catch {
          /* keep it encoded */
        }
        return `/api/rooms/${encodeURIComponent(o.roomId)}/assets/raw/${encodeURIComponent(name)}`;
      }
    }
    return u.href;
  }

  const trusted = (u) => trustedImageHost(u, { shareOrigin: share ? share.origin : null });
  /** a /raw/ URL on a host the page cannot vouch for yet: it may be the share */
  const maybeShare = (u) => share === null && u.pathname.startsWith('/raw/') && !trusted(u);

  function openFull(u, name, opener) {
    const lb = o.lightbox();
    const body = lb?.querySelector('#lbBody');
    const cap = lb?.querySelector('#lbCap');
    if (!lb || !body || !cap) {
      openExternal(u.href);
      return;
    }
    /* the thumbnails of the same line (its image set): ‹ › / arrow keys / mouse side buttons step through them [[ref]] */
    const siblings = [...(opener.parentElement?.querySelectorAll('.ril-thumb') ?? [])].filter((t) => !t.hidden && t.dataset.url);
    const set = siblings.length ? siblings.map((t) => new URL(t.dataset.url)) : [u];
    const at = Math.max(0, set.findIndex((x) => x.href === u.href));
    openGallery(lb, set.map((x) => ({ src: srcFor(x), name: imageName(x) })), at);
    /* give the focus back to the thumbnail when room-cells closes it */
    const mo = new MutationObserver(() => {
      if (lb.hidden) {
        mo.disconnect();
        if (opener.isConnected) {
          opener.focus({ preventScroll: true });
        }
      }
    });
    mo.observe(lb, { attributes: true, attributeFilter: ['hidden'] });
  }

  function thumb(u, one) {
    const name = imageName(u);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `att-img ril-thumb${one ? ' one' : ''}`;
    b.title = name;
    b.dataset.url = u.href;
    const img = document.createElement('img');
    img.alt = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      b.hidden = true; // quietly: the text link is still in the body
      const set = b.parentElement;
      if (set && ![...set.children].some((c) => !c.hidden && c.classList.contains('ril-thumb'))) {
        set.hidden = true;
      }
    });
    img.src = srcFor(u);
    b.append(img);
    const external = (ev) => ev.shiftKey || ev.metaKey || ev.ctrlKey;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // the line's own handlers (select, menu, reply) never see it
      if (external(ev)) {
        openExternal(u.href);
      } else {
        openFull(u, name, b);
      }
    });
    b.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        ev.stopPropagation();
        openExternal(u.href);
      }
    });
    return b;
  }

  function draw(set, urls) {
    const shown = urls.filter(trusted);
    if (!shown.length) {
      set.remove();
      return;
    }
    const first = shown.slice(0, IMAGE_SHOW_MAX);
    set.append(...first.map((u) => thumb(u, shown.length === 1)));
    if (shown.length > IMAGE_SHOW_MAX) {
      const rest = shown.slice(IMAGE_SHOW_MAX);
      const more = document.createElement('span');
      more.className = 'att-img ril-more';
      more.textContent = `+${rest.length}`;
      more.title = rest.map(imageName).join(', ');
      more.setAttribute('aria-label', `${rest.length} more image${rest.length > 1 ? 's' : ''}, linked in the text`);
      set.append(more);
    }
    set.hidden = false;
  }

  return {
    /** A line's image links as thumbnails, appended to `host` (the bubble, or
     *  a fact's own <li>). Nothing is fetched for an untrusted URL. */
    decorate(host, e) {
      const urls = imageUrlsIn(e.body ?? '');
      if (!urls.length) {
        return;
      }
      const set = document.createElement('div');
      set.className = 'entry-att ril-set';
      host.append(set);
      if (urls.some(maybeShare)) {
        set.hidden = true; // drawn once the share origin is known
        loadShare().then(() => draw(set, urls));
      } else {
        draw(set, urls);
      }
    },
  };
}
