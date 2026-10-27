'use strict';
// sessions:* and broker:* in the web build. Owner: a builder. The engine IS the broker here: one node, one group.
//   sessions:offer / :remove / :restore-spec   SUBSTITUTE, honestly empty: the "interrupted sessions" offer and "Recently closed"
//        rows are a desktop disk store the engine has no equivalent for (dropped for the pilot, said to the engine agent). The page
//        gets the same view shape with nothing in it, and restore says there is nothing to restore (null, the desktop's own answer).
//   sessions:dismiss   FORWARD POST /api/interrupted/dismiss, then the (empty) view.
//   broker:groups      FORWARD GET /api/sessions (live panes of this engine, hosted profile) -> the desktop's one-group shape;
//                      polled every 15 s while the page is visible (there is no push), emitted when it changed.
//   broker:end         FORWARD POST /api/sessions/:paneid/end.
//   broker:modules     PLATFORM-ONLY (the realm and a pinned broker are desktop things): classed so in web/channel-map.json.
const POLL_MS = 15000;
const PANE = /^[A-Za-z0-9._:#%-]{1,120}$/;

const scopeOf = (s) => (s && typeof s === 'object' && Number.isSafeInteger(s.selectionVersion) ? { accountId: typeof s.accountId === 'string' ? s.accountId : null, selectionVersion: s.selectionVersion } : { accountId: null, selectionVersion: 0 });
const offerView = (s) => ({ ...scopeOf(s), offer: null, recent: [] });

/** The engine's live panes -> the desktop's broker group rows. A pane id plays the broker session id (bsid). */
function groupFrom(panes) {
  const rows = panes.filter((p) => p && typeof p.paneid === 'string').map((p) => ({
    bsid: p.paneid, name: String(p.name || 'Terminal').slice(0, 80), folder: typeof p.folder === 'string' && p.folder ? p.folder : '~',
    startedOn: 'This server', recipeId: typeof p.recipeId === 'string' ? p.recipeId : null, hue: null, alive: p.alive !== false,
    endedAt: Number.isFinite(p.endedAt) ? p.endedAt : null, exitCode: Number.isInteger(p.exitCode) ? p.exitCode : null,
    createdAt: Number.isFinite(p.startedAt) ? p.startedAt : 0, openSid: null, openWid: null,
  }));
  return { serverId: 'local', serverName: 'This server', login: '', ok: true, state: 'live', protocol: null, live: rows.filter((r) => r.alive).length, cap: null, draining: false, graceUntil: 0, rows };
}

function register(api) {
  const timers = api.timers || { setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: (t) => globalThis.clearInterval(t) };
  let poll = null;
  let last = '';

  async function groups() {
    let res;
    try { res = await api.engine.fetch('/api/sessions'); } catch (e) { return []; }
    if (!res.ok) return []; // a server without the route, or a refusal: no group, never a made-up one
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    const panes = body && Array.isArray(body.sessions) ? body.sessions : Array.isArray(body) ? body : [];
    return [groupFrom(panes)];
  }
  async function refresh() {
    const g = await groups();
    const text = JSON.stringify(g);
    if (text !== last) { last = text; api.emit('broker:groups', { ...scopeOf(null), groups: g, keptRunning: 0 }); }
    return g;
  }
  const hidden = () => !!(globalThis.document && globalThis.document.hidden);
  function startPoll() {
    if (poll) return;
    poll = timers.setInterval(() => { if (!hidden()) void refresh(); }, POLL_MS);
    if (poll && poll.unref) poll.unref();
  }

  api.handle('sessions:offer', async () => offerView());
  api.handle('sessions:dismiss', async ([scope]) => {
    try { await api.engine.fetch('/api/interrupted/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch (e) { /* nothing was offered here */ }
    return offerView(scope);
  });
  api.handle('sessions:remove', async ([, scope]) => offerView(scope));
  api.handle('sessions:restore-spec', async () => null);

  api.handle('broker:groups', async () => { startPoll(); const g = await refresh(); return g; });
  api.handle('broker:end', async ([a]) => {
    const pane = a && typeof a.bsid === 'string' ? a.bsid : '';
    if (!PANE.test(pane)) return { ok: false, error: 'Choose a session to end.' };
    let res;
    try { res = await api.engine.fetch('/api/sessions/' + encodeURIComponent(pane) + '/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch (e) { return { ok: false, error: "Couldn't reach the server." }; }
    if (res.status === 404) return { ok: false, error: 'That session is already gone.' };
    if (!res.ok) return { ok: false, error: "The server wouldn't end that session." };
    setTimeout(() => void refresh(), 600);
    return { ok: true };
  });
}

module.exports = { register, groupFrom, offerView, POLL_MS };
