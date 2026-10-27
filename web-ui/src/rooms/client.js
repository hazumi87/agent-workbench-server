'use strict';
// Rooms (W1): the HTTP half of the room-service client, in the main process (the engine sends no CORS,
// so the renderer never talks to it). A person's requests carry the identity cookies and NOTHING else:
// no Authorization header (any one makes the request non-human), no Accept: text/html (an auth failure
// would then be a 302 to /login instead of a 401), no Origin. Contract: share workbench-app/ROOMS-API.md
// §1, §6.1; the PM's rulings .

const http = require('http');
const https = require('https');

const NET_MS = 10000;
const COOKIE_NAMES = ['homelab_session', 'homelab_device'];

/** `Set-Cookie` headers -> { name: value } for the two identity cookies only. */
function parseSetCookies(headers) {
  const out = {};
  const raw = headers['set-cookie'];
  for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(String(line));
    if (m && COOKIE_NAMES.includes(m[1])) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

function cookieHeader(cookies) {
  return COOKIE_NAMES.filter((n) => cookies && cookies[n]).map((n) => n + '=' + cookies[n]).join('; ');
}

/**
 * createClient({ base, cookies: () => ({homelab_session, homelab_device}) }).
 * request(method, path, { body, etag }) resolves { status, json, text, etag, headers, cookies } and
 * rejects with { code: 'unreachable' | 'timeout' | 'bad-url', message } when the engine cannot be reached.
 */
/** The routes this client may reach on the room service, and nothing else:
 *  sign-in and out, the room contract (/api/rooms…, a person's presence, a seat's held lines), and one read
 *  outside it, the person's recipes (GET /api/recipes, for New room and Add a seat). The /pty socket is live.js's. */
function allowed(method, p, localMode = false) {
  let u;
  try {
    u = new URL(String(p), 'http://x');
  } catch (e) {
    return false;
  }
  const path = u.pathname;
  const m = String(method || 'GET').toUpperCase();
  if (path.includes('..') || u.host !== 'x') {
    return false;
  }
  if ((path === '/login' || path === '/logout') && m === 'POST') {
    return true;
  }
  if (path === '/auth/realm/exchange' && m === 'POST') {
    return true; // A1: the engine ticket for a session (platform  item 7)
  }
  if (path === '/api/rooms' || path.startsWith('/api/rooms/')) {
    return true;
  }
  if (localMode && m === 'GET' && p === '/api/table') return true;
  if (path === '/api/presence/user' && m === 'GET') {
    return true;
  }
  if (/^\/api\/panes\/[^/]+\/deliver-held$/.test(path) && m === 'POST') {
    return true;
  }
  if (path === '/api/terminal-grants' && m === 'POST') {
    return true; // W3b: a one-time attach grant for one seated pane (PM )
  }
  if (!u.search && !u.hash && path === '/api/history-export') return m === 'GET' || m === 'PATCH';
  if (!u.search && !u.hash && ['/api/history-export/run','/api/history-export/cancel'].includes(path)) return m === 'POST';
  if (localMode && m === 'POST' && path === '/api/local/seed' && !u.search && !u.hash) return true;
  if (localMode && m === 'POST' && !u.search && !u.hash && /^\/api\/sessions\/[^/]+\/end$/.test(path)) return true;
  if (localMode && !u.search && !u.hash && ((path === '/api/recipes' && m === 'POST') || (/^\/api\/recipes\/app-local-[A-Za-z0-9_-]+$/.test(path) && m === 'DELETE'))) return true;
  return path === '/api/recipes' && m === 'GET';
}

/** W3b (R1, PM ): the one fixed Origin the app sends, on the grant request and the /term upgrade only. */
const TERM_ORIGIN = 'app://workbench';
/** A1: the exchange takes the same Origin, the ticket in the body only, and no other credential. */
const EXCHANGE_PATH = '/auth/realm/exchange';

function createClient(opts) {
  let base = null;
  let localSession = null, credentialEpoch = 0;
  const localMode = opts.localMode === true;
  function setBase(url) {
    if(localMode){localSession=null;++credentialEpoch;}
    base = null;
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return false;
      }
      if(localMode&&(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash))return false;
      base = u;
      return true;
    } catch (e) {
      return false;
    }
  }
  setBase(opts.base);

  function setLocalSession(value) {
    if(!localMode)throw Error('Local room session unavailable');
    localSession=null;++credentialEpoch;base=null;
    if(value===null)return;
    if(!value||typeof value.cookie!=='string'||!/^wb_auth=[A-Za-z0-9_-]{16,4096}$/.test(value.cookie)||!setBase(value.url))throw Error('Invalid local room session');
    localSession={url:base.origin,cookie:value.cookie};
  }
  function currentCookie() {
    if(!localMode)return cookieHeader(opts.cookies ? opts.cookies() : null);
    if(!localSession||base?.origin!==localSession.url)throw {code:'signed-out',message:'Local rooms unavailable'};
    return localSession.cookie;
  }
  const stale = epoch => localMode && epoch !== credentialEpoch;
  const staleError = () => ({code:'account-changed',message:'Local engine changed'});
  function extraHeaders(extra) {
    if(!localMode)return extra||{};
    return Object.fromEntries(Object.entries(extra||{}).filter(([key])=>!['authorization','cookie','origin','host'].includes(key.toLowerCase())));
  }

  function request(method, p, { body, etag, headers: extra } = {}) {
    return new Promise((resolve, reject) => {
      const epoch=credentialEpoch;
      if (!allowed(method, p, localMode)) {
        reject({ code: 'not-allowed', message: method + ' ' + String(p).split('?')[0] + ' is not a room route' });
        return;
      }
      if (!base) {
        reject({ code: 'bad-url', message: 'no rooms server address' });
        return;
      }
      const url = new URL(p, base);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { accept: 'application/json', ...extraHeaders(extra) };
      // A1: the exchange carries no cookie (the ticket is its only credential)
      const ck = url.pathname === EXCHANGE_PATH ? '' : currentCookie();
      if (ck) {
        headers.cookie = ck;
      }
      if (etag) {
        headers['if-none-match'] = etag;
      }
      let payload = null;
      if (body !== undefined) {
        payload = Buffer.from(JSON.stringify(body));
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payload.length);
      }
      // never: authorization, origin, accept text/html (ROOMS-API.md §6.1) — except the W3b grant, which must
      // carry the one fixed Workbench Origin (R1)
      delete headers.authorization;
      delete headers.origin;
      if (url.pathname === '/api/terminal-grants' || url.pathname === EXCHANGE_PATH) {
        headers.origin = TERM_ORIGIN;
      }
      const req = mod.request(url, { method, headers, timeout: NET_MS }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if(stale(epoch)){reject(staleError());return;}
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, json, text, etag: res.headers.etag || null, headers: res.headers, cookies: parseSetCookies(res.headers) });
        });
      });
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
      });
      req.on('error', (e) => {
        if(stale(epoch)){reject(staleError());return;}
        reject({ code: e && e.code === 'timeout' ? 'timeout' : 'unreachable', message: e && e.message ? e.message : 'unreachable' });
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /** GET bytes (a thumbnail, an asset): resolves { status, buffer, type } with the same cookie rules. */
  function requestBytes(p, { maxBytes = 12 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const epoch=credentialEpoch;
      if (!allowed('GET', p, localMode)) {
        reject({ code: 'not-allowed', message: 'GET ' + String(p).split('?')[0] + ' is not a room route' });
        return;
      }
      if (!base) {
        reject({ code: 'bad-url', message: 'no rooms server address' });
        return;
      }
      const url = new URL(p, base);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { accept: 'image/*,*/*' };
      const ck = currentCookie();
      if (ck) {
        headers.cookie = ck;
      }
      const req = mod.request(url, { method: 'GET', headers, timeout: NET_MS * 3 }, (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          resolve({ status: 413, buffer: null, type: '' });
          req.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            resolve({ status: 413, buffer: null, type: '' });
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => stale(epoch) ? reject(staleError()) : resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
      req.on('error', (e) => reject({ code: e && e.code === 'timeout' ? 'timeout' : 'unreachable', message: e && e.message ? e.message : 'unreachable' }));
      req.end();
    });
  }

  /** A request whose body is raw bytes (a scratch upload): headers carry the file name and type. */
  function requestRaw(method, p, buffer, extra) {
    return new Promise((resolve, reject) => {
      const epoch=credentialEpoch;
      if (!allowed(method, p, localMode)) {
        reject({ code: 'not-allowed', message: method + ' ' + String(p).split('?')[0] + ' is not a room route' });
        return;
      }
      if (!base) {
        reject({ code: 'bad-url', message: 'no rooms server address' });
        return;
      }
      const url = new URL(p, base);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { accept: 'application/json', ...extraHeaders(extra), 'content-length': String(buffer.length) };
      const ck = currentCookie();
      if (ck) {
        headers.cookie = ck;
      }
      delete headers.authorization;
      delete headers.origin;
      const req = mod.request(url, { method, headers, timeout: NET_MS * 6 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if(stale(epoch)){reject(staleError());return;}
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
      req.on('error', (e) => reject({ code: e && e.code === 'timeout' ? 'timeout' : 'unreachable', message: e && e.message ? e.message : 'unreachable' }));
      req.write(buffer);
      req.end();
    });
  }

  /** POST /login with the person's password. Resolves { ok, cookies, mustChangePassword } or { ok:false, status, error }. */
  async function login(username, password) {
    const r = await request('POST', '/login', { body: { username: String(username || ''), password: String(password || ''), remember: true } });
    if (r.status === 200 && r.cookies.homelab_session) {
      return { ok: true, cookies: r.cookies, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
    }
    return { ok: false, status: r.status, error: (r.json && (r.json.error || r.json.message)) || '' };
  }

  /** A1: POST /auth/realm/exchange { ticket } (no cookie, no Authorization, no query, Origin app://workbench).
   *  Resolves { ok, cookies, expiresAt, mustChangePassword } or { ok:false, status, field }; rejects when the
   *  engine can't be reached. The ticket is never put in a URL or a log. */
  async function exchange(ticket) {
    const r = await request('POST', EXCHANGE_PATH, { body: { ticket: String(ticket || '') } });
    if (r.status === 200 && r.cookies.homelab_session) {
      const exp = r.json && Number(r.json.expiresAt);
      return { ok: true, cookies: r.cookies, expiresAt: Number.isFinite(exp) ? exp : null, mustChangePassword: !!(r.json && r.json.mustChangePassword) };
    }
    return { ok: false, status: r.status, field: (r.json && typeof r.json.field === 'string' && r.json.field) || null };
  }

  async function logout() {
    try {
      await request('POST', '/logout', { body: {} });
    } catch (e) {
      // the cookies go either way
    }
  }

  return { request, requestBytes, requestRaw, login, exchange, logout, setBase, setLocalSession, currentCookie,
    base: () => (base ? base.origin : null), wsUrl: () => (base ? base.origin.replace(/^http/, 'ws') + '/pty' : null) };
}

module.exports = { createClient, parseSetCookies, cookieHeader, allowed, COOKIE_NAMES, TERM_ORIGIN };
