/* GLOBAL COLOR PALETTE, first paint (hub V2, Owner 2026-10-05). A CLASSIC script
 * in <head>, before the stylesheets paint: reads the cached token map
 * (localStorage, written by web/palette.mjs `remember`) and sets it on <html>
 * at once, so a Light or tinted palette never flashes the design system dark. Then it
 * reconciles with the server (GET /api/rooms/me, the person's own value) at
 * most once a minute (the cache's `at` is the last time it was verified) and, only when they differ, loads palette.mjs to
 * apply and re-cache. Another tab's change arrives by the `storage` event.
 * No cache and no answer = nothing set: the design system dark, today's look.
 * Every storage and network step is guarded: a page must render without them. */
(function () {
  var KEY = 'hwb.palette.v1';
  var doc = document, root = doc.documentElement;
  /* A CLI page (solo.html: <html data-palette="off">) keeps the design system dark whatever the global
     palette says: a terminal's colors are the CLI's, and light tokens turned its text black on
     the dark pane (Owner 2026-10-05). Nothing is painted, nothing is reconciled. */
  if (root.getAttribute('data-palette') === 'off') { root.dataset.mode = 'dark'; return; }
  var stamp = '';
  try { stamp = new URL(doc.currentScript.src).search; } catch (e) { /* unversioned is fine */ }
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function paint(c) {
    var k, meta;
    try {
      for (k in (c && c.map) || {}) root.style.setProperty('--' + k, c.map[k]);
      root.dataset.mode = c && c.mode === 'light' ? 'light' : 'dark';
      root.style.colorScheme = root.dataset.mode;
      meta = doc.querySelector('meta[name="theme-color"]');
      if (meta && c && c.theme) { meta.setAttribute('content', c.theme); }
    } catch (e) { /* keep going */ }
  }
  function clearAll(c) {
    var k;
    try { for (k in (c && c.map) || {}) root.style.removeProperty('--' + k); } catch (e) { /* ignore */ }
  }
  var cached = read();
  if (cached) { paint(cached); } else { root.dataset.mode = 'dark'; }
  /* another page changed it */
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) { return; }
    var next = read();
    clearAll(cached);
    cached = next;
    paint(next || { map: {}, mode: 'dark' });
  });
  var want = function (a, b) { return JSON.stringify(a || null) !== JSON.stringify(b || null); };
  function reconcile() {
    var at = cached && cached.at ? cached.at : 0;
    if (Date.now() - at < 60000) { return; }
    fetch('/api/rooms/me', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
      if (!me || !me.palette) { return; }
      var have = cached && cached.pref ? cached.pref : { key: 'aurora', mode: 'dark' };
      var pref = me.palette;
      var same = !want(have.key, pref.key) && !want(have.mode, pref.mode) && !want(have.custom, pref.custom);
      if (same) {
        try { if (cached) { cached.at = Date.now(); localStorage.setItem(KEY, JSON.stringify(cached)); } } catch (e) { /* ignore */ }
        return;
      }
      return import('/palette.mjs' + stamp).then(function (m) {
        clearAll(cached);
        m.remember(doc, pref);
        cached = read();
      });
    }).catch(function () { /* offline, 401 (login page): keep what is painted */ });
  }
  reconcile();
})();
