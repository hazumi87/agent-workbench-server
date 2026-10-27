'use strict';
// The rooms client for the browser: the same createClient interface as src/rooms/client.js (request,
// requestBytes, requestRaw, login, exchange, logout, setBase, setLocalSession, currentCookie, base, wsUrl),
// over fetch and the page's own origin. The browser carries the HttpOnly sign-in cookie itself, so this
// code never sees or sends it. The route allowlist is the DESKTOP client's own `allowed`, imported from
// the real file: the browser may reach exactly the routes the app does, and no others.
const real = require('client-real');
const { Buffer } = require('./shims/buffer');

const NET_MS = 10000;
const { SESSION_MARKER } = require('./session-marker'); // a flag that the browser holds a session; not a credential

function headersObject(h) {
  const out = {};
  h.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

function createClient(opts) {
  let base = null;
  const localMode = opts.localMode === true;
  function setBase(url) {
    base = null;
    try {
      const u = new URL(String(url || ''), globalThis.location ? globalThis.location.href : undefined);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      // the page talks to ITS OWN origin and nothing else (security review L4); a cross-origin base is refused
      if (globalThis.location && u.origin !== globalThis.location.origin) return false;
      base = u;
      return true;
    } catch (e) { return false; }
  }
  setBase(opts.base || (globalThis.location && globalThis.location.origin));

  function setLocalSession() { throw Error('Local room session unavailable in the browser'); }
  const currentCookie = () => '';

  async function doFetch(method, p, { headers = {}, body, timeoutMs = NET_MS, redirect = 'manual' } = {}) {
    if (!real.allowed(method, p, localMode)) throw { code: 'not-allowed', message: method + ' ' + String(p).split('?')[0] + ' is not a room route' };
    if (!base) throw { code: 'bad-url', message: 'no rooms server address' };
    const url = new URL(p, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store', redirect, signal: controller.signal });
      return res;
    } catch (e) {
      throw { code: e && e.name === 'AbortError' ? 'timeout' : 'unreachable', message: e && e.message ? e.message : 'unreachable' };
    } finally { clearTimeout(timer); }
  }
  // A redirect to /login is the engine saying "signed out"; with redirect:'manual' it arrives as an opaque
  // redirect, which the rooms core already treats as status 302.
  const statusOf = (res) => (res.type === 'opaqueredirect' ? 302 : res.status);

  async function request(method, p, { body, etag, headers: extra } = {}) {
    const headers = { accept: 'application/json', ...(extra || {}) };
    delete headers.authorization; delete headers.cookie; delete headers.origin;
    if (etag) headers['if-none-match'] = etag;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await doFetch(method, p, { headers, body: payload });
    const text = res.type === 'opaqueredirect' ? '' : await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    const status = statusOf(res);
    const isLogin = new URL(p, base).pathname === '/login';
    return { status, json, text, etag: res.headers.get('etag') || null, headers: headersObject(res.headers),
      cookies: isLogin && status === 200 ? { ...SESSION_MARKER } : {} };
  }

  async function requestBytes(p, { maxBytes = 12 * 1024 * 1024 } = {}) {
    const res = await doFetch('GET', p, { headers: { accept: 'image/*,*/*' }, timeoutMs: NET_MS * 3 });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { status: 413, buffer: null, type: '' };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) return { status: 413, buffer: null, type: '' };
    return { status: statusOf(res), buffer: Buffer.from(buf), type: res.headers.get('content-type') || '' };
  }

  async function requestRaw(method, p, buffer, extra) {
    const headers = { accept: 'application/json', ...(extra || {}) };
    delete headers.authorization; delete headers.cookie; delete headers.origin;
    const res = await doFetch(method, p, { headers, body: buffer, timeoutMs: NET_MS * 6 });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: statusOf(res), json, text, headers: headersObject(res.headers) };
  }

  async function login(username, password) {
    const r = await request('POST', '/login', { body: { username: String(username || ''), password: String(password || ''), remember: true } });
    if (r.status === 200) return { ok: true, cookies: r.cookies, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
    return { ok: false, status: r.status, error: (r.json && (r.json.error || r.json.message)) || '' };
  }
  // the realm ticket sign-in is a desktop-accounts feature: absent in the web build
  async function exchange() { return { ok: false, status: 0, field: null }; }
  async function logout() { try { await request('POST', '/logout', { body: {} }); } catch (e) { /* the browser drops the cookie either way */ } }

  return { request, requestBytes, requestRaw, login, exchange, logout, setBase, setLocalSession, currentCookie,
    base: () => (base ? base.origin : null),
    wsUrl: () => (base ? base.origin.replace(/^http/, 'ws') + '/pty' : null) };
}

module.exports = { createClient, parseSetCookies: real.parseSetCookies, cookieHeader: real.cookieHeader, allowed: real.allowed,
  COOKIE_NAMES: real.COOKIE_NAMES, TERM_ORIGIN: real.TERM_ORIGIN, SESSION_MARKER };
