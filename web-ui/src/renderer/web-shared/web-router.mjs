// The web build's three router seams, owned by the foundation and handed to the web slices as window.wb.web.router:
//   view          the authenticated view's generation: bumps when the signed-in state or the account changes, so
//                 anything started under an old view can ask current() and stop, or abort its signal.
//   registerPage  a web-only Settings page (its section, its Settings row, and an explicit show / hide / reset
//                 lifecycle called by the router, never by watching the DOM).
//   launchRecipe  start a recipe the page already names by id: only a known, well-formed id, never a command.
//   registerGate  a first-use gate (the four-step first login): once per authenticated view, before the shell shows, the router
//                 holds the shell hidden and inert behind a full-screen host until every gate passes. Pending and errors HOLD.
// Pure of the renderer's own state: the renderer hands it the page table, the two containers, openSettings, the list
// of recipe ids and its launch function. Nothing here reaches the network.

const PAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RECIPE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The generation of the signed-in view. A CHANGE of rooms:status.signedIn, or any accounts:changed, starts a new one. */
export function createViewGeneration({ wb }) {
  let generation = 0;
  let known; // the last signedIn value seen; undefined until the first status
  let controller = new AbortController();
  let alive = true;
  const subscribers = new Set();

  function bump(info) {
    generation += 1;
    controller.abort();
    controller = new AbortController();
    for (const fn of [...subscribers]) { try { fn(generation, info); } catch (e) { /* a subscriber must not stop the others */ } }
  }
  const offStatus = wb.on('rooms:status', (status) => {
    if (!alive) return;
    const next = status && status.signedIn === true ? true : status && status.signedIn === false ? false : null;
    if (next === known) return;
    known = next;
    bump({ signedIn: next });
  });
  const offAccounts = wb.on('accounts:changed', () => { if (alive) bump({}); });
  // the page may start after the first status was broadcast: ask once, and let an event that arrived meanwhile win
  const seeded = wb.rooms && typeof wb.rooms.status === 'function'
    ? Promise.resolve().then(() => wb.rooms.status()).then((status) => {
      if (!alive || known !== undefined) return;
      known = status && status.signedIn === true ? true : status && status.signedIn === false ? false : null;
      bump({ signedIn: known });
    }).catch(() => {})
    : Promise.resolve();

  return Object.freeze({
    generation: () => generation,
    signedIn: () => known === true,
    ready: seeded,
    current: (g) => alive && (g === undefined || g === generation),
    signal: () => controller.signal,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    destroy() { alive = false; if (typeof offStatus === 'function') offStatus(); if (typeof offAccounts === 'function') offAccounts(); subscribers.clear(); controller.abort(); },
  });
}

const camel = (id) => id.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

export function createWebRouter({ document, wb, pages, settingsRoot, navRoot, win, openSettings, recipeIds, launch, refreshRecipes, onSignedOut, gateTimeoutMs = 15000 }) {
  const view = createViewGeneration({ wb });
  const registered = new Map(); // id -> { mount, host, ctl }
  let shown = null;

  function leave() {
    if (shown === null) return;
    const entry = registered.get(shown);
    shown = null;
    try { entry.ctl?.hide(); } catch (e) { /* a page's own hide must not break the router */ }
  }

  function registerPage({ id, name, parent = 'global', label, icon = 'settings', value = '', mount }) {
    if (typeof id !== 'string' || !PAGE_ID.test(id)) throw new Error('page id invalid: ' + String(id));
    if (pages[id] || registered.has(id)) throw new Error('page already registered: ' + id);
    if (typeof mount !== 'function') throw new Error('mount function required for page ' + id);
    pages[id] = { name: String(name), parent };
    const host = document.createElement('div');
    host.className = 'sec';
    host.id = 'sec' + camel(id);
    host.dataset.page = id;
    host.hidden = true;
    settingsRoot.appendChild(host);
    // the router owns the section's visibility (the Settings panel toggles it); a page owns only this inner box
    const inner = document.createElement('div');
    host.appendChild(inner);
    const row = document.createElement('button');
    row.className = 'navrow';
    row.id = 'gs' + camel(id);
    const glyph = (text) => { const s = document.createElement('span'); s.className = 'ms'; s.setAttribute('aria-hidden', 'true'); s.textContent = text; return s; };
    const nl = document.createElement('span'); nl.className = 'nl'; nl.textContent = String(label);
    const nv = document.createElement('span'); nv.className = 'nv'; nv.textContent = String(value);
    row.append(glyph(icon), nl, nv, glyph('chevron_right'));
    row.addEventListener('click', () => openSettings(id));
    navRoot.appendChild(row);
    registered.set(id, { mount, host, inner, ctl: null });
  }

  /** Called by the renderer for every page it paints: show a web page, or leave the one that was showing. */
  async function render(page) {
    const entry = registered.get(page);
    if (!entry) { leave(); return; }
    if (shown !== null && shown !== page) leave();
    if (!entry.ctl) entry.ctl = entry.mount(entry.inner, Object.freeze({ view: api.view }));
    shown = page;
    try { await entry.ctl.show(); } catch (e) { /* the page reports its own failure; the router stays usable */ }
  }


  // ---- gates: the shell stays hidden and inert until every gate passes, for this authenticated view
  const GATE_ID = /^[a-z][a-z0-9-]{0,31}$/;
  const gates = [];
  let gateHost = null; let gateStatus = null; let gateBody = null;
  let sequence = 0; // a new run (a new view, a retry, a late registration) invalidates every older one
  let mounted = null; // { ctl } while a gate is on screen
  let wake = null; // resolves the wait of a shown gate or an error (done, retry, or teardown)

  function ensureGateHost() {
    if (gateHost) return;
    gateHost = document.createElement('div');
    gateHost.id = 'wbGate';
    gateHost.className = 'wb-gate';
    gateHost.setAttribute('role', 'dialog');
    gateHost.setAttribute('aria-modal', 'true');
    gateHost.setAttribute('aria-label', 'Getting started');
    gateHost.hidden = true;
    gateStatus = document.createElement('div');
    gateStatus.className = 'wb-gate-status';
    gateStatus.setAttribute('role', 'status');
    gateBody = document.createElement('div');
    gateBody.className = 'wb-gate-body';
    gateHost.append(gateStatus, gateBody);
    document.body.append(gateHost);
  }
  function hold(on) {
    ensureGateHost();
    gateHost.hidden = !on;
    if (win) {
      win.inert = on;
      if (on) win.setAttribute('aria-hidden', 'true'); else win.removeAttribute('aria-hidden');
    }
  }
  function say(text, retry) {
    gateStatus.replaceChildren();
    gateStatus.hidden = false;
    const p = document.createElement('p');
    p.textContent = text;
    gateStatus.append(p);
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Try again';
      b.addEventListener('click', retry);
      gateStatus.append(b);
    }
  }
  function unmount() {
    const m = mounted;
    mounted = null;
    if (m) { try { m.ctl.destroy(); } catch (e) { /* gone */ } }
    if (gateBody) gateBody.replaceChildren();
  }
  function release() {
    unmount();
    if (gateHost) { gateStatus.replaceChildren(); hold(false); }
  }
  /** pass | show | error; an answer that is not exactly one of the first two is an error, never an admission */
  function asked(gate, ctx) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('error'), gateTimeoutMs); });
    const answer = Promise.resolve().then(() => gate.check(ctx)).then((v) => (v === 'pass' || v === 'show' ? v : 'error'), () => 'error');
    return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
  }
  const waitFor = () => new Promise((resolve) => { wake = resolve; });

  async function runGates() {
    const mine = ++sequence;
    if (wake) { const w = wake; wake = null; w(); } // let an older run's wait end; it sees it is stale
    unmount();
    if (!gates.length || !view.signedIn()) { release(); return; }
    const g = view.generation();
    const signal = view.signal();
    const live = () => mine === sequence && view.current(g) && view.signedIn();
    hold(true);
    for (const gate of gates) {
      for (;;) {
        say('Checking…');
        const result = await asked(gate, { signal, current: live });
        if (!live()) return;
        if (result === 'pass') break;
        if (result === 'error') { const wait = waitFor(); say("Couldn't check. Try again.", () => { const w = wake; wake = null; if (w) w(); }); await wait; if (!live()) return; continue; }
        // show: the gate's own screen; done() or retry() asks again, the view ending ends it
        gateStatus.replaceChildren();
        gateStatus.hidden = true;
        const wait = waitFor();
        const poke = () => { const w = wake; wake = null; if (w) w(); };
        const ctl = gate.mount(gateBody, Object.freeze({ view: api.view, signal, done: poke, retry: poke }));
        mounted = { ctl };
        try { await ctl.show(); } catch (e) { /* the gate reports its own failure; it stays up */ }
        await wait;
        unmount();
        if (!live()) return;
      }
    }
    if (live()) release();
  }

  function registerGate({ id, check, mount }) {
    if (typeof id !== 'string' || !GATE_ID.test(id)) throw new Error('gate id invalid: ' + String(id));
    if (gates.some((x) => x.id === id)) throw new Error('gate already registered: ' + id);
    if (typeof check !== 'function') throw new Error('check function required for gate ' + id);
    if (typeof mount !== 'function') throw new Error('mount function required for gate ' + id);
    gates.push({ id, check, mount });
    if (view.signedIn()) void runGates();
  }

  // a new authenticated view: nothing the old one read may stay on screen; a sign-out also clears what the page stored
  view.subscribe((generation, info) => {
    if (info && info.signedIn === false && typeof onSignedOut === 'function') { try { onSignedOut(); } catch (e) { /* storage unavailable: nothing to clear */ } }
    leave();
    for (const entry of registered.values()) { try { entry.ctl?.reset(); } catch (e) { /* see leave() */ } }
    void runGates(); // a new view: the gates ask again (or let go, when the view is no longer signed in)
  });

  async function launchRecipe(id, { signal, current } = {}) {
    if (typeof id !== 'string' || !RECIPE_ID.test(id)) return { ok: false, error: 'unknown-recipe' };
    const stale = () => (signal && signal.aborted) || (typeof current === 'function' && current() === false);
    if (!recipeIds().includes(id)) {
      // a recipe the engine has just created (a sign-in recipe) is not in the cached list yet: read the list ONCE, fenced by the view
      if (typeof refreshRecipes === 'function') {
        try { await refreshRecipes(); } catch (e) { return { ok: false, error: 'unknown-recipe' }; }
        if (stale()) return { ok: false, error: 'cancelled' };
      }
      if (!recipeIds().includes(id)) return { ok: false, error: 'unknown-recipe' };
    }
    if (stale()) return { ok: false, error: 'cancelled' };
    try { await launch(id); } catch (e) { return stale() ? { ok: false, error: 'cancelled' } : { ok: false, error: 'failed' }; }
    return stale() ? { ok: false, error: 'cancelled' } : { ok: true };
  }

  // pages and slices get the read side of the view; only the router can end it
  const pageView = Object.freeze({ generation: view.generation, current: view.current, signal: view.signal, subscribe: view.subscribe, signedIn: view.signedIn });
  const api = Object.freeze({ view: pageView, registerPage, registerGate, launchRecipe });
  return { api, view, registerPage, registerGate, render, close: leave, launchRecipe };
}
