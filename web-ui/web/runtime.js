'use strict';
// The browser stand-in for Electron's main process: one registry that the renderer half (ipcRenderer in
// the preload shim) and the main half (ipcMain, used by the real rooms core and by web/handlers/*.js)
// share. It routes every call by its CLASS in web/channel-map.json and makes failure loud:
//   forward / substitute  -> the registered handler; none registered = NotImplemented (red banner)
//   platform-only         -> PlatformOnly (red banner); a native feature never resolves in a browser
//   absent                -> rejects {code:'absent'} quietly: the renderer's own "not present" path
//   unclassified          -> UnclassifiedChannel (red banner); the coverage check stops this at build time
const channelMap = require('./channel-map.json');

const handlers = new Map(); // channel -> fn(event, ...args)
const listeners = new Map(); // channel -> fn(event, ...args), for send()
const inbound = new Map(); // channel -> Set<fn(payload)>
const eventHandlers = new Map();
// window.wb.web.events: page-level events the web slices subscribe to ('room-shown' so far, fired from renderer.js).
// A listener that throws never breaks the page or the other listeners.
const exposed = { events: {
  on(name, fn) { if (!eventHandlers.has(name)) eventHandlers.set(name, new Set()); eventHandlers.get(name).add(fn); return () => eventHandlers.get(name).delete(fn); },
  off(name, fn) { const set = eventHandlers.get(name); if (set) set.delete(fn); },
  fire(name, payload) { for (const fn of [...(eventHandlers.get(name) || [])]) { try { fn(payload); } catch (e) { defect('ListenerError', 'web.events:' + name); } } },
} }; // window.wb.web.*
const defects = []; // {kind, channel, count}, read by tests as window.__wbWebDefects
// Publish before handlers initialize: shared answer rows can report the first defect.
globalThis.__wbWebDefects = defects;
let bannerEl = null;

const meta = () => globalThis.__WB_WEB__ || {};
const version = () => String(meta().version || '');

function rowFor(channel, table) {
  if (table[channel]) return table[channel];
  const star = Object.keys(table).find((k) => k.endsWith('*') && channel.startsWith(k.slice(0, -1)));
  return star ? table[star] : null;
}

function banner() {
  if (bannerEl || !globalThis.document) return;
  bannerEl = document.createElement('div');
  bannerEl.id = 'wb-web-banner';
  bannerEl.setAttribute('role', 'alert');
  bannerEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b00020;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 10px;white-space:pre-wrap;max-height:30vh;overflow:auto';
  const attach = () => document.body.appendChild(bannerEl);
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
}
function defect(kind, channel) {
  const seen = defects.find((d) => d.kind === kind && d.channel === channel);
  if (seen) seen.count += 1; else defects.push({ kind, channel, count: 1 });
  globalThis.__wbWebDefects = defects;
  banner();
  if (bannerEl) bannerEl.textContent = 'Web build: ' + defects.length + ' call(s) that do not work here\n' + defects.map((d) => d.kind + '(' + d.channel + ')' + (d.count > 1 ? ' x' + d.count : '')).join('\n');
}
function fail(kind, channel, code) {
  defect(kind, channel);
  return Object.assign(new Error(kind + ': ' + channel), { name: kind, code, channel });
}
const platformOnly = (what) => fail('PlatformOnly', what, 'platform-only');

const event = () => ({ sender: { id: 1, isDestroyed: () => false, getURL: () => globalThis.location ? globalThis.location.href : '' }, senderFrame: {} });

async function invoke(channel, args) {
  const row = rowFor(channel, channelMap.outbound);
  if (!row) throw fail('UnclassifiedChannel', channel, 'unclassified');
  if (row.class === 'platform-only') throw platformOnly(channel);
  if (row.class === 'absent') throw Object.assign(new Error('absent: ' + channel), { code: 'absent', channel });
  const fn = handlers.get(channel);
  if (!fn) throw fail('NotImplemented', channel, 'not-implemented');
  return fn(event(), ...args);
}
function send(channel, args) {
  const row = rowFor(channel, channelMap.outbound);
  if (!row) { fail('UnclassifiedChannel', channel, 'unclassified'); return; }
  if (row.class === 'platform-only') { platformOnly(channel); return; }
  if (row.class === 'absent') return;
  const fn = listeners.get(channel);
  if (!fn) { defect('NotImplemented', channel); return; }
  try { fn(event(), ...args); } catch (e) { defect('HandlerError', channel); }
}

function onInbound(channel, fn) {
  if (!rowFor(channel, channelMap.inbound)) { defect('UnclassifiedChannel', channel); return () => {}; }
  if (!inbound.has(channel)) inbound.set(channel, new Set());
  inbound.get(channel).add(fn);
  return () => offInbound(channel, fn);
}
function offInbound(channel, fn) { const set = inbound.get(channel); if (set) set.delete(fn); }
function emit(channel, payload) {
  for (const fn of [...(inbound.get(channel) || [])]) {
    try { fn(event(), payload); } catch (e) { defect('ListenerError', channel); }
  }
}

const duplicates = []; // two modules answering the same channel: ownership must be moved, never doubled
function registerHandler(channel, fn) { if (handlers.has(channel)) duplicates.push(channel); handlers.set(channel, fn); }
function registerListener(channel, fn) { if (listeners.has(channel)) duplicates.push(channel); listeners.set(channel, fn); }
function removeHandler(channel) { handlers.delete(channel); }

// What a handler module sees. args are the preload's own argument array; the scoped rooms envelope is part of it.
const api = {
  handle: (channel, fn) => registerHandler(channel, (e, ...args) => fn(args, { event: e })),
  on: (channel, fn) => registerListener(channel, (e, ...args) => fn(args, { event: e })),
  emit,
  expose: (name, value) => { if (name === 'events') throw new Error('web.events is reserved'); exposed[name] = value; },
  engine: {
    // same-origin only (security review L4): a path that starts with one "/", never an absolute or protocol-relative URL
    fetch: (path, init) => {
      const origin = globalThis.location.origin;
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('engine.fetch takes a same-origin path starting with "/"');
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error('engine.fetch is same-origin only');
      return globalThis.fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(init || {}) });
    },
  },
  platformOnly,
};

function modulesForInit() {
  const base = new URL('./', globalThis.location ? globalThis.location.href : 'http://localhost/');
  return (meta().modules || []).map((m) => ({ ...m, url: new URL(m.url, base).href, enabled: m.core ? true : m.defaultEnabled, settings: {} }));
}
function initPayload() {
  return {
    debug: { on: false, path: '' }, startupLog: '', modules: modulesForInit(), userModulesDir: '', version: version(), wid: 1,
    platform: 'linux', skippedLocalRecipes: [], sessions: [], accounts: false, firstRunHint: false,
  };
}
function boot(register) {
  for (const fn of register) fn(api);
  globalThis.wb = globalThis.wb || {};
  globalThis.wb.web = exposed; // the preload shim has set window.wb by now; web-only features hang off .web
  globalThis.__wbWebChannels = () => ({ handlers: [...handlers.keys()].sort(), listeners: [...listeners.keys()].sort(), exposed: Object.keys(exposed).sort(), duplicates: [...duplicates] }); // for the coverage check and tests
  const sendInit = () => {
    emit('init', initPayload());
    // the stable readiness marker for the proof lane: set only after init went out and the rooms core registered
    if (globalThis.document && document.documentElement) document.documentElement.setAttribute('data-wb-web', 'ready');
    globalThis.__wbWeb = { ready: true, version: version() };
  };
  if (globalThis.document && document.readyState !== 'complete') globalThis.addEventListener('load', () => setTimeout(sendInit, 0));
  else setTimeout(sendInit, 0);
}

module.exports = { invoke, send, onInbound, offInbound, emit, registerHandler, registerListener, removeHandler, platformOnly, version, boot, api,
  _state: { handlers, listeners, defects, duplicates, exposed } };
