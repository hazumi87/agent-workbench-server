/* THE APPS TAB of the room's + sheet (the design system room-add-sheet-v1 §2-3).
 *
 * [ticket/1906] Registering, approving and unregistering an app are
 * installation-WIDE acts, so they live in Settings → Apps (web/settings-apps.mjs),
 * not here. This tab only adds registered apps to THIS room and takes apps
 * out of it, in two sections:
 *   IN THIS ROOM — the apps the room holds, whatever their state (a held or
 *     unregistered app keeps its place; its view works, its actions do not);
 *   CAN BE ADDED — every other app the engine knows: registered ones can be
 *     added (or moved here), and a candidate / held / unregistered one shows
 *     its chip and a "Settings ›" link, never a button that would fail.
 * Every row carries the registration chip (Registered / Needs approval / Not
 * registered: web/app-status.mjs). The room words (Not running · In "<other
 * room>") stay beside it. Actions: Add (teal outline) · Remove (ghost, no
 * confirm, an Undo toast) · Move here… (amber outline: an exclusive app held
 * by another room; an alertdialog built from the engine's answer).
 * Everything applies AT ONCE (the footer says so) — except in a NEW room,
 * where the room does not exist yet: there an Add is remembered and done
 * right after the room is made ("adds with the room").
 *
 * The ENGINE decides every state and every refusal; this module words them.
 * Contract: GET /api/apps ({apps, candidates}) · POST /api/rooms/:id/apps
 * {slug, move?, force?} · DELETE /api/rooms/:id/apps/:slug.
 */
import { stateChip, settingsLink } from '/app-status.mjs';

const ICONS = {
  tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  assets: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  studio: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16"/>',
};
ICONS.list = ICONS.tasks;
ICONS.image = ICONS.assets;
ICONS.images = ICONS.assets;
ICONS.sparkle = ICONS.studio;
ICONS.mic = ICONS.voice;

const ELL = String.fromCharCode(8230);
const MDASH = String.fromCharCode(8212);

function icon(key) {
  const k = typeof key === 'string' && Object.prototype.hasOwnProperty.call(ICONS, key) ? key : 'panel';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;
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
function btn(cls, text, fid) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (fid) {
    b.dataset.fid = fid;
  }
  return b;
}

/** The Move dialog's what-happens list: the app's own truth (alpha-platform,
 *  2026-09-28, for Image Studio), worded with the app's and rooms' names. */
/** The Move dialog's what-happens list: only lines TRUE for this app. The
 *  generic move; the job line only for an app that declares jobs; then the
 *  app's OWN words (tool.json move_notes, via the catalog). No app's text is
 *  written here. */
function moveLines(name, from, jobs, notes) {
  return [
    `It leaves "${from}", and its panel there goes.`,
    ...(jobs ? ['A job already running there finishes there.'] : []),
    ...(Array.isArray(notes) && notes.length ? notes : [`What "${from}" keeps is up to ${name}.`]),
  ];
}

/**
 * @param {object} ctx
 *   call(path, json?, method?) -> {ok,status,body}
 *   roomId() -> the target room's id, or null (a NEW room: adds are pending)
 *   roomName() -> its name (for the dialog), render(), toast(text, act?),
 *   dialog(spec) -> the sheet's alertdialog, applied(body) (the room page folds
 *   a route's answer in), goAgents() (the no-seat line's link)
 */
export function createAppsTab(ctx) {
  const st = {
    loaded: false,
    unavailable: '', // the engine has no apps routes (yet): said, not hidden
    apps: [],
    cands: [], // folders not registered yet (GET /api/apps `candidates`)
    rowErr: new Map(), // slug -> {text, tone}
    busy: new Set(), // slug
    pending: new Map(), // NEW room only: slug -> {move}
  };

  async function load() {
    const r = await ctx.call('/api/apps').catch((e) => ({ ok: false, status: 0, body: { error: e?.message } }));
    st.loaded = true;
    if (!r.ok || !Array.isArray(r.body?.apps)) {
      st.unavailable = r.status === 404 ? "This engine doesn't list apps yet." : `Could not list apps ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`;
      st.apps = [];
    } else {
      st.unavailable = '';
      st.apps = r.body.apps.filter((a) => a && typeof a.slug === 'string');
      st.cands = (Array.isArray(r.body.candidates) ? r.body.candidates : []).filter((c) => c && typeof c.slug === 'string');
    }
    ctx.render();
  }

  const nameOf = (a) => a.name || a.slug;
  /** the registration state (an older engine sends no `state`: derive it) */
  const regState = (a) => a.state || (a.status === 'held' ? 'needs-approval' : 'registered');
  const inHere = (a) => {
    const id = ctx.roomId();
    return id ? (a.rooms || []).some((x) => (x.ids || [x.id]).includes(id)) : st.pending.has(a.slug);
  };
  const elsewhere = (a) => {
    const id = ctx.roomId();
    return a.access === 'exclusive' ? (a.rooms || []).find((x) => !(x.ids || [x.id]).includes(id)) || null : null;
  };
  const panelWords = (a) => (a.panels || []).map((p) => p.title).filter(Boolean).join(', ') || nameOf(a);

  /** how many apps this room holds (or will): the tab's count */
  function count() {
    return ctx.roomId() ? st.apps.filter(inHere).length : st.pending.size;
  }

  /* ---- actions ---- */

  function setErr(slug, text, tone = 'bad') {
    if (text) {
      st.rowErr.set(slug, { text, tone });
    } else {
      st.rowErr.delete(slug);
    }
  }

  /** bind: 'called' (the app confirmed), null (a shared app: no bind at all),
   *  'not-supported' (an exclusive app with no HTTP bind: say so). A failed
   *  bind is never a 200 (it is a 502). */
  function bindNote(a, bind) {
    return bind === 'not-supported' ? ` ${MDASH} ${nameOf(a)}'s agent must re-bind itself` : '';
  }

  /** POST .../apps and word what came back. Returns 'ok' | 'dialog' | 'err'. */
  async function addApp(a, opts = {}) {
    const id = ctx.roomId();
    const json = { slug: a.slug };
    if (opts.move) {
      json.move = true;
    }
    if (opts.force) {
      json.force = true;
    }
    const r = await ctx.call(`/api/rooms/${encodeURIComponent(id)}/apps`, json);
    if (r.ok) {
      setErr(a.slug, '');
      await ctx.applied(r.body);
      const moved = r.body?.moved_from;
      ctx.toast(`${moved || opts.move ? 'Moved' : 'Added'} ${nameOf(a)}${moved?.name ? ` from "${moved.name}"` : ''}${bindNote(a, r.body?.bind)}`);
      return { kind: 'ok' };
    }
    const b = r.body || {};
    if (r.status === 409 && b.error === 'exclusive') {
      return { kind: 'exclusive', heldBy: b.heldBy || elsewhere(a) };
    }
    if (r.status === 409 && b.error === 'bind-refused' && b.reason === 'job-running') {
      return { kind: 'jobs', jobs: Array.isArray(b.jobs) ? b.jobs : [] };
    }
    if (r.status === 409 && b.reason === 'no-seat') {
      return { kind: 'no-seat' };
    }
    if (r.status === 409 && (b.error === 'held' || b.error === 'not-registered')) {
      return { kind: b.error };
    }
    if (r.status === 502 && b.error === 'bind-failed') {
      const verb = opts.move ? 'moved' : 'added';
      /* the engine could not verify the answering process IS the app's own
         (rooms/apps-sec): say so, not the generic "isn't answering" */
      if (b.reason === 'endpoint-unverified') {
        return { kind: 'err', text: `${nameOf(a)} isn't answering from its own process, so it can't be ${verb} right now. Nothing moved.` };
      }
      if (b.reason === 'endpoint-unverified-platform') {
        return { kind: 'err', text: `${nameOf(a)}'s process can't be verified on this host, so it can't be ${verb} here. Nothing moved.` };
      }
      /* the app declares a bind handshake and did not answer it (or is down) */
      return { kind: 'err', text: `${nameOf(a)} isn't answering, so it can't be ${verb} right now. Nothing moved.` };
    }
    return { kind: 'err', text: `${nameOf(a)} not ${opts.move ? 'moved' : 'added'} ${MDASH} ${b.error ?? b.reason ?? `HTTP ${r.status}`}` };
  }

  function wordResult(a, res) {
    if (res.kind === 'no-seat') {
      setErr(a.slug, `${nameOf(a)}'s agent needs a seat in this room first. Add it on the Agents tab.`, 'warn');
    } else if (res.kind === 'held') {
      setErr(a.slug, `${nameOf(a)} needs approval in Settings ${String.fromCharCode(8594)} Apps first.`, 'warn');
    } else if (res.kind === 'not-registered') {
      setErr(a.slug, `${nameOf(a)} is not registered: register it in Settings ${String.fromCharCode(8594)} Apps first.`, 'warn');
    } else if (res.kind === 'err') {
      setErr(a.slug, res.text);
    }
  }

  async function onAdd(a) {
    if (!ctx.roomId()) {
      st.pending.set(a.slug, { move: false });
      ctx.render();
      return;
    }
    st.busy.add(a.slug);
    setErr(a.slug, '');
    ctx.render();
    try {
      const res = await addApp(a);
      if (res.kind === 'exclusive') {
        openMove(a, res.heldBy);
      } else if (res.kind === 'jobs') {
        openMove(a, elsewhere(a), res.jobs);
      } else {
        wordResult(a, res);
      }
    } catch (e) {
      setErr(a.slug, `${nameOf(a)} not added ${MDASH} ${e?.message ?? e}`);
    } finally {
      st.busy.delete(a.slug);
      await load();
    }
  }

  async function onRemove(a) {
    if (!ctx.roomId()) {
      st.pending.delete(a.slug);
      ctx.render();
      return;
    }
    st.busy.add(a.slug);
    setErr(a.slug, '');
    ctx.render();
    try {
      const r = await ctx.call(`/api/rooms/${encodeURIComponent(ctx.roomId())}/apps/${encodeURIComponent(a.slug)}`, {}, 'DELETE');
      if (!r.ok) {
        setErr(a.slug, `${nameOf(a)} not removed ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`);
        return;
      }
      await ctx.applied(r.body);
      ctx.toast(`Removed ${panelWords(a)}`, {
        label: 'Undo',
        run: async () => {
          const res = await addApp(a);
          if (res.kind !== 'ok') {
            wordResult(a, res.kind === 'exclusive' || res.kind === 'jobs' ? { kind: 'err', text: `${nameOf(a)} not put back: another room took it` } : res);
          }
          await load();
        },
      });
    } catch (e) {
      setErr(a.slug, `${nameOf(a)} not removed ${MDASH} ${e?.message ?? e}`);
    } finally {
      st.busy.delete(a.slug);
      await load();
    }
  }

  /* ---- the Move dialog (an alertdialog; Cancel is the default) ---- */

  /** The Move dialog. Resolves when it closes: 'moved' | 'cancelled' |
   *  'refused' (a no-seat / held answer, said on the row). */
  function openMove(a, heldBy, jobs) {
    let done;
    const result = new Promise((r) => { done = r; });
    let outcome = 'cancelled';
    const from = heldBy?.name || 'the other room';
    const name = nameOf(a);
    const spec = { title: '', intro: '', lines: [], cancel: 'Cancel', ok: 'Move here', err: '', busy: false, onClose: () => done(outcome) };
    const plain = () => {
      spec.title = `Move ${name} here?`;
      spec.intro = `${name} is exclusive: one room at a time.`;
      spec.lines = moveLines(name, from, a.jobs === true, a.move_notes);
      spec.cancel = 'Cancel';
      spec.ok = 'Move here';
      spec.force = false;
    };
    const busyJobs = (list) => {
      const n = list.length || 1;
      spec.title = `${n} job${n === 1 ? ' is' : 's are'} running in "${from}"`;
      spec.intro = `Wait keeps ${name} in "${from}" until ${n === 1 ? 'it finishes' : 'they finish'}. Move anyway moves it now; a running job still finishes there.`;
      spec.lines = [];
      spec.cancel = 'Wait';
      spec.ok = 'Move anyway';
      spec.force = true;
    };
    if (jobs) {
      busyJobs(jobs);
    } else {
      plain();
    }
    spec.onOk = async (d) => {
      spec.busy = true;
      spec.err = '';
      d.update();
      let res;
      try {
        res = await addApp(a, { move: true, force: spec.force });
      } catch (e) {
        res = { kind: 'err', text: `${name} not moved ${MDASH} ${e?.message ?? e}` };
      }
      spec.busy = false;
      if (res.kind === 'ok') {
        outcome = 'moved';
        st.pending.delete(a.slug);
        d.close();
        await load();
        return;
      }
      if (res.kind === 'jobs') {
        busyJobs(res.jobs);
        d.update();
        return;
      }
      if (res.kind === 'err') {
        spec.err = res.text;
        d.update();
        return;
      }
      outcome = 'refused';
      d.close();
      wordResult(a, res);
      await load();
    };
    ctx.dialog(spec);
    return result;
  }

  /* ---- drawing ---- */

  /** A DOWN exclusive app with an HTTP bind cannot be added or moved: the
   *  engine calls the bind, and a bind to an app that is not running is a 502
   *  (bind-failed). Say so and disable the button, rather than offering an
   *  Add that is certain to fail. A shared app (or one with no HTTP bind) is
   *  added while down; its panel fills in once it runs. */
  const NEEDS_RUNNING = 'can be added once it runs';
  function blockedDown(a) {
    return a.status === 'down' && a.access === 'exclusive' && a.bind === true;
  }

  function stateOf(a) {
    const here = inHere(a);
    if (regState(a) !== 'registered') {
      return null; // the chip says it
    }
    if (here) {
      return ctx.roomId() ? { cls: 'in', word: 'In this room' }
        : { cls: 'in', word: st.pending.get(a.slug)?.move ? 'Moves here with the room' : 'Adds with the room' };
    }
    const other = elsewhere(a);
    if (other) {
      return { cls: 'held', word: `In "${other.name}"` };
    }
    if (a.status === 'down') {
      return { cls: 'down', word: blockedDown(a) ? `Not running ${String.fromCharCode(183)} ${NEEDS_RUNNING}` : 'Not running' };
    }
    return null;
  }

  function appRow(a) {
    const row = el('div', 'ras-app');
    row.dataset.slug = a.slug;
    const ic = el('span', 'ras-ic');
    ic.innerHTML = icon(a.icon || a.panels?.[0]?.icon);
    const mid = el('div', 'ras-amid');
    const top = el('div', 'a');
    top.append(el('span', 'ras-aname', nameOf(a)), stateChip(regState(a)));
    const s = stateOf(a);
    if (s) {
      const w = el('span', `ras-st ${s.cls}`);
      w.append(el('i'), s.word);
      top.append(w);
    }
    mid.append(top);
    const d = el('div', 'd', a.description || '');
    if (a.status === 'down' && !blockedDown(a) && regState(a) === 'registered') {
      d.append(' ', el('span', 'ras-off', 'It shows offline until the app runs.'));
    } else if (blockedDown(a) && !inHere(a) && elsewhere(a)) {
      /* held elsewhere: the state word names that room, so the reason Move is
         off goes here */
      d.append(' ', el('span', 'ras-off', `Not running ${String.fromCharCode(183)} ${NEEDS_RUNNING}.`));
    }
    mid.append(d);
    const panels = (a.panels || []).map((p) => p.title).filter(Boolean);
    mid.append(el('div', 'm', `panel${panels.length > 1 ? 's' : ''}: ${panels.join(', ') || MDASH}${a.access === 'exclusive' ? ' · exclusive · one room at a time' : ''}`));
    const err = st.rowErr.get(a.slug);
    if (err) {
      const e = el('div', `ras-aerr ${err.tone}`, err.text);
      e.setAttribute('role', 'status');
      mid.append(e);
    }
    const acts = el('div', 'acts');
    const busy = st.busy.has(a.slug);
    const add = (b, fn, gated = false) => {
      const off = gated && blockedDown(a);
      b.disabled = busy || off;
      if (off) {
        const why = `Not running: ${nameOf(a)} ${NEEDS_RUNNING}`;
        b.title = why;
        b.setAttribute('aria-label', `${b.textContent} (${why})`);
      }
      b.addEventListener('click', () => void fn(a));
      acts.append(b);
    };
    const registered = regState(a) === 'registered';
    if (!registered) {
      /* registering / approving is Settings → Apps' job [ticket] */
      const l = settingsLink();
      l.dataset.fid = `set-${a.slug}`;
      acts.append(l);
    }
    if (inHere(a)) {
      add(btn('ras-btn sm', 'Remove', `rm-${a.slug}`), onRemove);
    } else if (!registered) {
      /* nothing to add until it is registered (and approved) */
    } else if (elsewhere(a)) {
      add(btn('ras-btn sm warn', `Move here${ELL}`, `mv-${a.slug}`), (x) => {
        if (!ctx.roomId()) {
          /* a NEW room: remembered; its confirm comes at Create (the design system) */
          st.pending.set(x.slug, { move: true });
          ctx.render();
          return;
        }
        void openMove(x, elsewhere(x));
      }, true);
    } else {
      add(btn('ras-btn sm pri', 'Add', `add-${a.slug}`), onAdd, true);
    }
    row.append(ic, mid, acts);
    return row;
  }

  /** A folder with a tool.json that is not registered: its chip and the way
   *  to Settings, nothing to press here. */
  function candRow(c) {
    const row = el('div', 'ras-app ras-cand');
    row.dataset.slug = c.slug;
    const ic = el('span', 'ras-ic');
    ic.innerHTML = icon('panel');
    const mid = el('div', 'ras-amid');
    const top = el('div', 'a');
    top.append(el('span', 'ras-aname', c.name || c.slug), stateChip('unregistered-candidate'));
    mid.append(top, el('div', 'd', c.description || ''));
    mid.append(el('div', 'm', c.ok === false ? `tool.json has problems ${MDASH} see Settings` : `${c.contract || 'no contract'} · not registered`));
    const acts = el('div', 'acts');
    const l = settingsLink();
    l.dataset.fid = `set-${c.slug}`;
    acts.append(l);
    row.append(ic, mid, acts);
    return row;
  }

  function section(box, title, n, fid) {
    const sec = el('div', 'ras-sec');
    sec.dataset.sec = fid;
    sec.append(title, el('span', 'sp'), el('span', 'c', String(n)));
    box.append(sec);
  }

  function listBody(box) {
    if (!st.loaded) {
      box.append(el('div', 'ras-empty', `Loading apps${ELL}`));
      return;
    }
    if (st.unavailable) {
      box.append(el('div', 'ras-empty', st.unavailable));
      return;
    }
    const here = st.apps.filter(inHere);
    const rest = st.apps.filter((a) => !inHere(a));
    section(box, 'In this room', here.length, 'here');
    if (!here.length) {
      box.append(el('div', 'ras-empty', 'No apps in this room yet.'));
    }
    for (const a of here) {
      box.append(appRow(a));
    }
    section(box, 'Can be added', rest.length + st.cands.length, 'add');
    if (!rest.length && !st.cands.length) {
      box.append(el('div', 'ras-empty', st.apps.length ? 'Every registered app is in this room.' : 'No apps are registered yet.'));
    }
    /* registered first (they can be added), then held / unregistered, then
       folders never registered */
    const rank = (a) => (regState(a) === 'registered' ? 0 : 1);
    for (const a of [...rest].sort((x, y) => rank(x) - rank(y))) {
      box.append(appRow(a));
    }
    for (const c of st.cands) {
      box.append(candRow(c));
    }
    const more = el('p', 'ras-regnote');
    more.append('Register, approve or unregister apps for every room in ', settingsLink(`Settings ${String.fromCharCode(8594)} Apps ${String.fromCharCode(8250)}`), '.');
    box.append(more);
  }

  /** The Apps footer (an existing room; a NEW room's is the Agents one). */
  function footer(ft, close) {
    ft.append(el('span', 'ras-note', 'Changes apply at once.'));
    const done = btn('ras-btn', 'Done', 'done');
    done.addEventListener('click', close);
    ft.append(done);
  }

  /** after a NEW room is made: its pending adds, in order. Returns problems. */
  async function applyPending() {
    const out = [];
    for (const [slug, p] of [...st.pending]) {
      const a = st.apps.find((x) => x.slug === slug) || { slug, name: slug };
      if (p.move) {
        /* the Move-with-room's CONFIRM, now that the room exists (the design system) */
        const said = await openMove(a, elsewhere(a));
        if (said !== 'moved') {
          st.pending.delete(slug);
          if (said !== 'cancelled') { // a Cancel is a choice, not a failure
            out.push(st.rowErr.get(slug)?.text ?? `${nameOf(a)} was not moved`);
          }
        }
        continue;
      }
      let res;
      try {
        res = await addApp(a, { move: p.move });
      } catch (e) {
        res = { kind: 'err', text: `${nameOf(a)} not added ${MDASH} ${e?.message ?? e}` };
      }
      if (res.kind === 'ok') {
        st.pending.delete(slug);
      } else {
        out.push(res.kind === 'err' ? res.text
          : res.kind === 'no-seat' ? `${nameOf(a)}'s agent needs a seat in the room first`
            : res.kind === 'jobs' ? `${nameOf(a)} not moved: a job is running in its room (try Move here again)`
              : res.kind === 'exclusive' ? `${nameOf(a)} not added: another room holds it`
                : res.kind === 'not-registered' ? `${nameOf(a)} not added: it is not registered`
                  : `${nameOf(a)} not added: it needs approval`);
      }
    }
    return out;
  }

  return {
    load,
    count,
    body: (box) => listBody(box),
    footer,
    pendingCount: () => st.pending.size,
    pendingMoves: () => [...st.pending.values()].filter((p) => p.move).length,
    applyPending,
    isRegister: () => false, // registering moved to Settings → Apps [ticket]
    loaded: () => st.loaded,
  };
}
