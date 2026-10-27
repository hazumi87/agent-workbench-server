/* ============================================================================
 * SETTINGS → APPS [ticket] (Owner 2026-09-30: "registering an app is an
 * installation-wide act, so doing it from one room's + sheet is confusing"). Mounted
 * by the global Settings page (web/settings.mjs, the mount contract there):
 *
 *   const { mountAppsSettings } = await import('/settings-apps.mjs');
 *   mountAppsSettings(el, { me, save });   // me/save unused: apps are not `me`
 *
 * Every app the engine knows (GET /api/apps: the registry, each with `state`,
 * `rooms` and — held — its `pending` change; plus `candidates`, the tool
 * folders not registered yet), one row each: the state chip (Registered /
 * Needs approval / Not registered, web/app-status.mjs), the rooms using it,
 * and what a person may do:
 *   Register        a candidate (POST /api/apps/:slug/register, with the
 *                   sha256 the row showed: a file that changed since answers
 *                   409 'changed' and the row re-reads)
 *   Register again  an unregistered app: back on its LAST APPROVED tool.json,
 *                   so a change made while it was out waits for Approve
 *   Approve         a held app, with the permission change shown on the row
 *                   (the words the + sheet's dialog used; POST
 *                   /api/apps/:slug/approve {expected_sha256})
 *   Unregister      with an inline confirm step on the row (never confirm()):
 *                   POST /api/apps/:slug/unregister. The app stays in its
 *                   rooms' rails; only its actions stop.
 * Every one of these is HUMAN-ONLY at the engine (the window cookie this page
 * rides); an agent's bearer or pane token can never do them.
 *
 * Deep link: /settings.html#apps (the section's id is the group id). The list
 * re-reads when the page comes back into view (update) and on #apps.
 * ========================================================================== */
import { stateChip, diffLines, diffIntro, ensureStyles } from '/app-status.mjs';
import { toneSwatches } from '/settings-tones.mjs';

const ELL = String.fromCharCode(8230);
const MDASH = String.fromCharCode(8212);
const STAMP = new URL(import.meta.url).search;

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
function button(cls, text, id) {
  const b = mk('button', cls, text);
  b.type = 'button';
  if (id) {
    b.dataset.act = id;
  }
  return b;
}

function ensureOwnStyles() {
  ensureStyles();
  if (document.querySelector('link[data-settings-apps]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `/settings-apps.css${STAMP}`;
  l.dataset.settingsApps = '1';
  document.head.append(l);
}

async function call(path, json) {
  const init = json === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) };
  try {
    const res = await fetch(path, init);
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
  }
}

/** @param {HTMLElement} el
 *  @param {{me?: object, save?: (patch: object) => Promise}} [ctx] the page's shared
 *  /api/rooms/me object and its saver: the "Title bar" tone row needs both (hub V2) */
export async function mountAppsSettings(el, ctx = {}) {
  ensureOwnStyles();
  const st = {
    loaded: false,
    err: '',
    apps: [], // registry rows (state registered | needs-approval | unregistered-candidate)
    cands: [], // folders never registered
    toolsDir: '',
    busy: new Set(), // slug
    msg: new Map(), // slug -> {text, kind}
    confirm: null, // slug awaiting the Unregister confirm
  };

  const list = mk('div', 'sa-list');
  const status = mk('p', 'pv-msg');
  status.setAttribute('role', 'status');
  el.append(
    mk('p', 'pv-note sa-intro', 'Apps registered here can be added to any room. Approving a change or unregistering an app applies in every room that uses it.'),
    status,
    list,
  );

  async function load() {
    const r = await call('/api/apps');
    st.loaded = true;
    if (!r.ok || !Array.isArray(r.body?.apps)) {
      st.err = `Could not list apps ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`;
    } else {
      st.err = '';
      st.apps = r.body.apps.filter((a) => a && typeof a.slug === 'string');
      st.cands = (Array.isArray(r.body.candidates) ? r.body.candidates : []).filter((c) => c && typeof c.slug === 'string');
      st.toolsDir = typeof r.body.tools_dir === 'string' ? r.body.tools_dir : '';
    }
    render();
  }

  const nameOf = (a) => a.name || a.slug;
  const say = (slug, text, kind = '') => {
    if (text) {
      st.msg.set(slug, { text, kind });
    } else {
      st.msg.delete(slug);
    }
  };

  async function act(slug, path, json, done) {
    st.busy.add(slug);
    say(slug, '');
    render();
    const r = await call(path, json);
    st.busy.delete(slug);
    if (r.status === 409 && r.body?.error === 'changed') {
      say(slug, 'Its tool.json changed again since this was shown; review the new change.', 'warn');
    } else if (!r.ok) {
      say(slug, `${done.fail} ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`, 'error');
    } else {
      say(slug, done.ok);
    }
    await load();
  }

  const register = (x) => act(x.slug, `/api/apps/${encodeURIComponent(x.slug)}/register`, x.sha256 ? { expected_sha256: x.sha256 } : {},
    { ok: 'Registered.', fail: 'Not registered' });
  const approve = (a) => {
    const sha = a.pending?.sha256 ?? a.sha256;
    return act(a.slug, `/api/apps/${encodeURIComponent(a.slug)}/approve`, sha ? { expected_sha256: sha } : {},
      { ok: 'Approved: its actions work again.', fail: 'Not approved' });
  };
  const unregister = (a, supersededBy) => {
    st.confirm = null;
    /* [app supersede] Owner 2026-10-05: the person may name the app that replaces this one, so
       old room links to it open there (resolved at read time; stored lines are never rewritten) */
    return act(a.slug, `/api/apps/${encodeURIComponent(a.slug)}/unregister`, supersededBy ? { superseded_by: supersededBy } : {},
      { ok: 'Unregistered: its actions are blocked; it stays in its rooms.', fail: 'Not unregistered' });
  };

  function roomsLine(rooms) {
    const names = (Array.isArray(rooms) ? rooms : []).map((r) => `"${r.name}"`);
    return names.length ? `In ${names.join(', ')}` : 'Not in any room';
  }

  function row(x, kind) {
    /* kind: 'app' (a registry row) | 'cand' (a folder never registered) */
    const state = kind === 'cand' ? 'unregistered-candidate' : x.state || (x.status === 'held' ? 'needs-approval' : 'registered');
    const r = mk('div', 'sa-app');
    r.dataset.slug = x.slug;
    r.dataset.state = state;
    const top = mk('div', 'sa-top');
    top.append(mk('span', 'sa-name', nameOf(x)), stateChip(state));
    r.append(top);
    if (x.description) {
      r.append(mk('div', 'sa-d', x.description));
    }
    if (kind === 'app' && ctx.me && ctx.save) {
      /* TITLE BAR (hub V2, Owner 2026-10-05): the tone this app wears in every room's rail, per person */
      const tb = mk('div', 'sa-tb', 'Title bar');
      const tm = mk('span', 'pv-msg');
      tb.append(toneSwatches(x, ctx.me, ctx.save, (t) => {
        tm.textContent = t || '';
        tm.dataset.kind = t ? 'error' : '';
      }), tm);
      r.append(tb);
    }
    if (kind === 'app' && x.superseded_by && x.superseded_by.name) {
      r.append(mk('div', 'sa-rooms', `Replaced by ${x.superseded_by.name}`)); // [app supersede] Owner 2026-10-05
    }
    r.append(mk('div', 'sa-rooms', kind === 'cand' ? `Not registered ${MDASH} ${x.root || x.slug}` : roomsLine(x.rooms)));
    if (kind === 'cand' && x.ok === false) {
      r.append(mk('div', 'sa-probs', `Can't be registered: ${(x.problems || []).join('; ') || 'tool.json is not valid'}`));
    }
    if (state === 'needs-approval') {
      const p = x.pending || {};
      const lines = p.diff ? diffLines(p.diff) : [];
      const box = mk('div', 'sa-diff');
      box.append(mk('p', 'sa-dintro', p.pinned_at ? diffIntro(p, lines) : 'Its tool.json changed since it was approved.'));
      if (lines.length) {
        const ul = mk('ul', 'sa-dl');
        for (const l of lines) {
          const li = mk('li', l.cls, l.text);
          ul.append(li);
        }
        box.append(ul);
      }
      box.append(mk('p', 'pv-note', 'Until you approve it, its panels still show but its actions are blocked.'));
      r.append(box);
    }
    if (kind === 'app' && state === 'unregistered-candidate') {
      r.append(mk('p', 'pv-note', 'Register it again to unblock its actions. It comes back on its last approved tool.json; a change made since waits for your approval.'));
    }

    const busy = st.busy.has(x.slug);
    const acts = mk('div', 'sa-acts');
    if (st.confirm === x.slug) {
      const n = (x.rooms || []).length;
      const q = mk('div', 'sa-confirm');
      q.setAttribute('role', 'group');
      q.setAttribute('aria-label', `Unregister ${nameOf(x)}?`);
      q.append(mk('span', 'sa-q', `Unregister ${nameOf(x)}? ${n ? `Its actions stop in ${n} room${n === 1 ? '' : 's'}; it stays in their rails.` : 'Its actions stop.'} Nothing of its data is deleted.`));
      const no = button('pv-btn', 'Cancel', `cancel-${x.slug}`);
      no.addEventListener('click', () => {
        st.confirm = null;
        render();
      });
      /* replaced by: any other registered, approved app (the engine validates again) */
      const succ = mk('label', 'sa-succ', 'Old links open in ');
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'App that replaces this one');
      sel.append(new Option('nothing (links stop)', ''));
      for (const o of st.apps) {
        const ost = o.state || (o.status === 'held' ? 'needs-approval' : 'registered');
        if (o.slug !== x.slug && ost === 'registered' && !o.superseded_by) {
          sel.append(new Option(nameOf(o), o.slug));
        }
      }
      succ.append(sel);
      const yes = button('pv-btn sa-danger', 'Unregister', `confirm-${x.slug}`);
      yes.addEventListener('click', () => void unregister(x, sel.value));
      q.append(succ, no, yes);
      acts.append(q);
    } else if (kind === 'cand') {
      const b = button('pv-btn pri', busy ? `Registering${ELL}` : 'Register', `register-${x.slug}`);
      b.disabled = busy || x.ok === false;
      b.addEventListener('click', () => void register(x));
      acts.append(b);
    } else {
      if (state === 'needs-approval') {
        const b = button('pv-btn pri', busy ? `Approving${ELL}` : 'Approve', `approve-${x.slug}`);
        b.disabled = busy;
        b.addEventListener('click', () => void approve(x));
        acts.append(b);
      }
      if (state === 'unregistered-candidate') {
        const b = button('pv-btn pri', busy ? `Registering${ELL}` : 'Register again', `register-${x.slug}`);
        b.disabled = busy;
        b.addEventListener('click', () => void register(x));
        acts.append(b);
      } else {
        const b = button('pv-btn', 'Unregister', `unregister-${x.slug}`);
        b.disabled = busy;
        b.addEventListener('click', () => {
          st.confirm = x.slug;
          render();
        });
        acts.append(b);
      }
    }
    r.append(acts);
    const m = st.msg.get(x.slug);
    if (m) {
      const p = mk('p', 'pv-msg', m.text);
      if (m.kind) {
        p.dataset.kind = m.kind;
      }
      p.setAttribute('role', 'status');
      r.append(p);
    }
    return r;
  }

  function render() {
    const keep = document.activeElement?.dataset?.act ?? null;
    list.replaceChildren();
    status.textContent = st.loaded ? st.err : `Loading apps${ELL}`;
    status.dataset.kind = st.err ? 'error' : '';
    if (!st.loaded || st.err) {
      return;
    }
    const rank = { 'needs-approval': 0, registered: 1, 'unregistered-candidate': 2 };
    const apps = [...st.apps].sort((a, b) => (rank[a.state] ?? 1) - (rank[b.state] ?? 1) || nameOf(a).localeCompare(nameOf(b)));
    for (const a of apps) {
      list.append(row(a, 'app'));
    }
    for (const c of st.cands) {
      list.append(row(c, 'cand'));
    }
    if (!apps.length && !st.cands.length) {
      list.append(mk('p', 'pv-note', `No apps found${st.toolsDir ? ` in ${st.toolsDir}` : ''}.`));
    }
    /* keep the focus on the control the person used (not a text field: this
       group has none, so nothing here raises a phone keyboard) */
    if (keep) {
      list.querySelector(`[data-act="${CSS.escape(keep)}"]`)?.focus();
    }
  }

  render();
  await load();
  window.addEventListener('hashchange', () => {
    if (location.hash === '#apps') {
      void load();
    }
  });
  let at = 0;
  let lastTones = JSON.stringify(ctx.me?.tones ?? {});
  return {
    update() {
      if (ctx.me && JSON.stringify(ctx.me.tones ?? {}) !== lastTones) {
        lastTones = JSON.stringify(ctx.me.tones ?? {}); // a tone changed (the palette group, another tab)
        render();
      }
      /* the page came back into view: re-read (coalesced, at most every 2 s) */
      if (Date.now() - at > 2000) {
        at = Date.now();
        void load();
      }
    },
  };
}
