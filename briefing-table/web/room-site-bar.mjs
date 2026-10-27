/* THE PREVIEW / PUBLIC BAR [basic] (Owner 2026-10-08, lead [ref]): in a SITE room of a Basic instance, a bar under the room's top row says where the site
 * is and lets the person move it: a Preview link, a Public on/off switch, the public link with Copy, and Publish now.
 *
 * Data: GET /api/rooms/:id/site -> {slug, id, name?, previewUrl, publicUrl, published, lastPublishedAt, changedSinceSave, error?}; every field null when
 * the room is not a site room (the bar stays hidden), a 404 when the engine is not Basic (hidden too). It is read on load, on window focus, every
 * 60 s while the page is visible, and every 4 s for a minute after the person asked for a change.
 *
 * THE SWITCH ASKS, IT DOES NOT ACT. Publishing changes what the world can see, so the switch sends /publish or /unpublish to the agent as a TYPED
 * command (the engine adds the "explain what this does and ask before acting" marker) and the switch only moves when `site status` says it did. Until
 * then it reads "asked @agent..." beside it, never a flipped switch the site does not honour. */

const SLOW_MS = 60000;
const FAST_MS = 4000;
const FAST_FOR_MS = 60000;

/** A published-at as milliseconds: the engine sends an ISO string (the remote-ops "since <ts>"), a number is taken as ms (or seconds when it is small); anything else is none. */
export function stampMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** The bar's model from the engine's answer; null = nothing to show. Pure, so a test can read it. */
export function barModel(site) {
  if (!site || typeof site !== 'object' || !site.slug) {
    return null;
  }
  const published = site.published === true;
  const publicUrl = typeof site.publicUrl === 'string' && /^https?:\/\//.test(site.publicUrl) ? site.publicUrl : null;
  const previewUrl = typeof site.previewUrl === 'string' && /^https?:\/\//.test(site.previewUrl) ? site.previewUrl : null;
  return {
    name: site.name || site.slug,
    previewUrl,
    published,
    publicUrl: published ? publicUrl : null,
    lastPublishedAt: stampMs(site.lastPublishedAt),
    changed: site.changedSinceSave === true,
    /* Publish now: only when the site IS public and the public copy is behind your latest save (a private site is published by the switch) */
    canPublishNow: published && site.changedSinceSave === true,
    error: typeof site.error === 'string' && site.error ? site.error : null,
  };
}

/** The command the switch sends for the state the person is asking for. */
export const switchCommand = (wantOn) => (wantOn ? '/publish' : '/unpublish');

/**
 * @param {{roomId: string, api: (path:string, o?:object)=>Promise<{ok:boolean,status:number,body:any}>,
 *          sendTyped: (text:string)=>Promise<boolean>, copy: (text:string)=>Promise<boolean>,
 *          toast: (text:string, o?:object)=>void, place: (el:HTMLElement)=>void, agent?: ()=>string|null,
 *          when?: (ts:number)=>string}} o
 */
export function mountSiteBar(o) {
  const el = document.createElement('div');
  el.id = 'siteBar';
  el.className = 'site-bar';
  el.hidden = true;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Site');
  o.place(el);
  let model = null;
  let asked = null; // {on:boolean, at:number}
  let timer = 0;
  let stopped = false;

  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  };

  function paint() {
    if (!model) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = '';
    /* TWO THINGS, NOT ONE CONTROL (the design system, Basic design pass): a link button for the private copy, then a divider, then the Public group: its label
       BEFORE the switch, then (only while public) the address, Copy and the time. Off it reads "Public · off". */
    const open = model.previewUrl ? mk('a', 'sb-open', 'Open preview \u2197') : mk('span', 'sb-open is-off', 'Open preview \u2197');
    if (model.previewUrl) {
      open.href = model.previewUrl;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.title = 'Only you can see this copy';
    }
    const pub = mk('div', 'sb-pub');
    pub.dataset.on = model.published ? '1' : '0';
    pub.append(mk('span', 'sb-lbl', 'Public'));
    const sw = mk('button', 'sb-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(model.published));
    sw.setAttribute('aria-label', 'Public');
    sw.dataset.on = model.published ? '1' : '0';
    sw.append(mk('span', 'sb-knob'));
    sw.addEventListener('click', () => void ask(!model.published));
    pub.append(sw);
    if (!model.published) {
      pub.append(mk('span', 'sb-off', '\u00b7 off'));
    }
    if (asked) {
      pub.append(mk('span', 'sb-asked', `asked ${o.agent?.() ?? 'the agent'} to ${asked.on ? 'publish' : 'unpublish'}\u2026`));
    }
    if (model.publicUrl) {
      const link = mk('a', 'sb-addr', model.publicUrl.replace(/^https?:\/\//, ''));
      link.href = model.publicUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const copy = mk('button', 'sb-btn sb-copy', 'Copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', 'Copy the public link');
      copy.addEventListener('click', async () => {
        const done = await o.copy(model.publicUrl);
        o.toast(done ? 'Public link copied' : 'Could not copy the link', { kind: done ? undefined : 'error' });
      });
      pub.append(link, copy);
      if (model.lastPublishedAt && o.when) {
        pub.append(mk('span', 'sb-when', `published ${o.when(model.lastPublishedAt)}`));
      }
    }
    el.append(open, mk('span', 'sb-div'), pub);
    if (model.canPublishNow) {
      /* the public copy is behind your latest save: the amber state */
      const behind = mk('span', 'sb-behind');
      behind.append(mk('span', 'sb-behind-t', 'Changes not published yet'));
      const now = mk('button', 'sb-btn sb-now', 'Publish now');
      now.type = 'button';
      now.title = 'The public copy is behind your latest save';
      now.addEventListener('click', () => void ask(true));
      behind.append(now);
      el.append(behind);
    }
    if (model.error) {
      const err = mk('span', 'sb-err', 'status unavailable');
      err.title = model.error;
      el.append(err);
    }
  }

  async function ask(wantOn) {
    asked = { on: wantOn, at: Date.now() };
    paint();
    let sent = false;
    try {
      sent = await o.sendTyped(switchCommand(wantOn));
    } catch {
      sent = false;
    }
    if (!sent) {
      asked = null;
      o.toast('Could not send that to the agent', { kind: 'error' });
      paint();
      return;
    }
    schedule(FAST_MS);
  }

  async function load() {
    if (stopped) {
      return;
    }
    try {
      const r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/site`);
      model = r.ok ? barModel(r.body) : null; // a 404 (not Basic) hides it
    } catch {
      /* keep the last bar: a blip must not blank it */
    }
    if (asked && model && model.published === asked.on) {
      asked = null; // the site agrees now
    }
    if (asked && Date.now() - asked.at > FAST_FOR_MS) {
      asked = null; // the agent never did it (it asked you first, or declined): the switch stays where the site is
    }
    paint();
    schedule(asked ? FAST_MS : SLOW_MS);
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        schedule(SLOW_MS);
        return;
      }
      void load();
    }, ms);
  }
  window.addEventListener('focus', () => void load());
  void load();
  return {
    refresh: () => load(),
    stop() {
      stopped = true;
      clearTimeout(timer);
      el.remove();
    },
    el,
  };
}
