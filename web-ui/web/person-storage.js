'use strict';
// Browser storage rule (Client #N): the page's localStorage may hold the session-present marker and non-secret UI state
// (room ids, tab layout, panel state, theme), and NEVER a credential, a message body, a note or a file's content. Everything
// the app writes is namespaced per signed-in person (the handle the engine returned), and CLEARED on sign-out and when a
// different person is seen. This is the facade the page's `localStorage` is replaced with, before any app code runs.
//   activate(person)  string: this person (another one's keys are wiped first) | null: signed out (all wiped, locked)
//                     | undefined: the engine did not answer (the last person stays, nothing is wiped)
//   clear()           sign-out while the page is open: every app key wiped, the facade locked until the next load
const PREFIX = 'wbp.';
const LAST = PREFIX + '#last';
const LEGACY = /^wb[-.]/; // what an older build wrote unprefixed (wb.zoom, wb-web-fs, ...); other keys on the origin are not ours

const enc = (s) => encodeURIComponent(String(s)).replace(/\./g, '%2E');

function createPersonStorage({ backing }) {
  let ns = null; // 'wbp.<person>.' while a person is active
  const keysOf = () => { const out = []; for (let i = 0; i < backing.length; i++) out.push(backing.key(i)); return out; };
  const wipe = () => { for (const k of keysOf()) if (k.startsWith(PREFIX)) backing.removeItem(k); };
  const wipeLegacy = () => { for (const k of keysOf()) if (!k.startsWith(PREFIX) && LEGACY.test(k)) backing.removeItem(k); };
  const mine = () => (ns ? keysOf().filter((k) => k.startsWith(ns)) : []);

  const getItem = (k) => (ns ? backing.getItem(ns + String(k)) : null);
  const setItem = (k, v) => { if (ns) backing.setItem(ns + String(k), String(v)); };
  const removeItem = (k) => { if (ns) backing.removeItem(ns + String(k)); };
  const clearMine = () => { for (const k of mine()) backing.removeItem(k); };
  const key = (n) => { const k = mine()[n]; return k === undefined ? null : k.slice(ns.length); };
  const methods = { getItem, setItem, removeItem, clear: clearMine, key };

  const facade = new Proxy({}, {
    get(_, prop) {
      if (prop === 'length') return mine().length;
      if (Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop];
      if (typeof prop === 'symbol') return undefined;
      const v = getItem(prop);
      return v === null ? undefined : v;
    },
    set(_, prop, value) { if (typeof prop === 'string') setItem(prop, value); return true; },
    deleteProperty(_, prop) { if (typeof prop === 'string') removeItem(prop); return true; },
    has(_, prop) { return prop === 'length' || Object.prototype.hasOwnProperty.call(methods, prop) || (typeof prop === 'string' && getItem(prop) !== null); },
    ownKeys() { return mine().map((k) => k.slice(ns.length)); },
    getOwnPropertyDescriptor(_, prop) { const v = typeof prop === 'string' ? getItem(prop) : null; return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
  });

  function activate(person) {
    if (person === undefined) { // the engine did not say: keep whoever was here last, wipe nothing
      const last = backing.getItem(LAST);
      ns = last ? PREFIX + last + '.' : null;
      return;
    }
    if (person === null) { wipe(); wipeLegacy(); ns = null; return; }
    const id = enc(person);
    wipeLegacy();
    if (backing.getItem(LAST) !== id) wipe();
    backing.setItem(LAST, id);
    ns = PREFIX + id + '.';
  }
  function clear() { wipe(); wipeLegacy(); ns = null; }

  return { facade, activate, clear };
}

const WORDS = /(authorization|bearer\s|password|passwd|api[_-]?key|secret|"token"\s*:|token\s*[=:])/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Would this stored value pass for a credential? Used by the tests that scan what the page really stored. */
function looksSecret(value) {
  const s = String(value);
  if (WORDS.test(s)) return true;
  return /[A-Za-z0-9+/_=-]{40,}/.test(s.replace(UUID, ''));
}

/** Replace window.localStorage with the facade (the page, before any app code), and wipe sessionStorage's app keys on clear. */
function install({ win = globalThis, answer }) {
  const real = win.localStorage;
  const ps = createPersonStorage({ backing: real });
  ps.activate(answer.state === 'in' ? answer.handle : answer.state === 'out' ? null : undefined);
  Object.defineProperty(win, 'localStorage', { configurable: true, enumerable: true, get: () => ps.facade });
  const clear = () => {
    ps.clear();
    try { const s = win.sessionStorage; for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k && /^wb[-.]/.test(k)) s.removeItem(k); } } catch (e) { /* none */ }
  };
  return { clear, facade: ps.facade };
}

module.exports = { createPersonStorage, looksSecret, install, PREFIX };
