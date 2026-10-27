'use strict';
// "Is this browser signed in?" is the ENGINE's answer, not a stored flag. Once per page load, before the rooms core reads
// its marker, the page asks the engine on its own origin (GET /api/rooms/me: 200 JSON from that route is a person
// signed in, a 401/403 or a redirect to the login page is not) and the stored marker is made to agree. The marker stays
// a first-paint hint only. A synchronous request is deliberate: the rooms core reads the marker synchronously at its
// start, so the answer has to be in before it does; it is one same-origin call per load.
const { SESSION_MARKER, SECRETS_FILE } = require('./session-marker');

const ME = '/api/rooms/me';

/** -> {state:'in', handle} | {state:'out'} | {state:'unknown'} (the engine did not answer, so nothing is concluded) */
function askEngine({ XHR = globalThis.XMLHttpRequest, origin = globalThis.location && globalThis.location.origin } = {}) {
  if (typeof XHR !== 'function') return { state: 'unknown' };
  try {
    const x = new XHR();
    x.open('GET', ME, false);
    x.setRequestHeader('accept', 'application/json');
    x.send(null);
    if (!x.status || x.status >= 500) return { state: 'unknown' };
    // a redirect to the login page reports the page it landed on: only an answer FROM the person route counts
    let from = ME;
    try { from = new URL(x.responseURL || ME, origin || 'http://localhost').pathname; } catch (e) { from = ''; }
    if (from !== ME || x.status !== 200) return { state: 'out' };
    let body = null;
    try { body = JSON.parse(x.responseText); } catch (e) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { state: 'out' };
    return { state: 'in', handle: String(body.handle || body.name || '').trim() || 'person' };
  } catch (e) {
    return { state: 'unknown' };
  }
}

/** Make the stored marker agree with the answer. `unknown` changes nothing (and an absent marker stays absent). */
function syncMarker({ answer, fs }) {
  if (answer.state === 'in') {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify({ cookies: SESSION_MARKER }));
    return { signedIn: true, handle: answer.handle };
  }
  if (answer.state === 'out') {
    try { fs.rmSync(SECRETS_FILE, { force: true }); } catch (e) { /* none */ }
    return { signedIn: false };
  }
  return { signedIn: fs.existsSync(SECRETS_FILE), unknown: true };
}

module.exports = { askEngine, syncMarker, ME };
