'use strict';
// window.wb.web.storage.clear(): wipes every key the app stored in this browser (the person-scoped state and the session
// marker). The router calls it on sign-out (Client #N). The facade itself is installed by the bundle entry, before any
// app code; this only hands out its clear(), once, and forgets the global it was passed in.
function register(api) {
  const held = globalThis.__wbPersonStorage;
  delete globalThis.__wbPersonStorage;
  api.expose('storage', Object.freeze({ clear: () => { if (held) held.clear(); } }));
}

module.exports = { register };
