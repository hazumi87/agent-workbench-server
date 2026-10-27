'use strict';
// The ONE value the web build stores about a sign-in: a fixed flag saying "this browser holds a session".
// It is not a credential and not encrypted: the real session is the engine's HttpOnly cookie, which page code
// can neither read nor write. The rooms core keeps this flag in its per-device "secrets" file (web/shims/fs.js)
// so a reload does not show the sign-in card while the cookie is still valid.
// The marker is a first-paint HINT: web/session-probe.js makes it agree with the engine's own answer on every load, so it
// never grants or denies a sign-in by itself. SECRETS_FILE is where the rooms core reads it (the rooms handler's dir + rooms.secrets).
module.exports = { SESSION_MARKER: Object.freeze({ homelab_session: 'browser-session' }), SECRETS_FILE: '/wb-web/rooms.secrets' };
