'use strict';
// `electron` for the browser, both halves. The renderer half (preload.js: contextBridge, ipcRenderer) and
// the main half (the rooms core: ipcMain, net, safeStorage, dialog, BrowserWindow, app) meet in one
// registry, web/runtime.js. Nothing here pretends a native feature works: dialog and BrowserWindow throw
// PlatformOnly, and the page shows it.
const rt = require('../runtime');

const ipcMain = {
  handle: (channel, fn) => rt.registerHandler(channel, fn),
  on: (channel, fn) => rt.registerListener(channel, fn),
  removeHandler: (channel) => rt.removeHandler(channel),
};

const ipcRenderer = {
  invoke: (channel, ...args) => rt.invoke(channel, args),
  send: (channel, ...args) => { rt.send(channel, args); },
  on: (channel, fn) => rt.onInbound(channel, fn),
  removeListener: (channel, fn) => rt.offInbound(channel, fn),
};

const contextBridge = {
  // the browser has one world: the API is the page's own window.wb
  exposeInMainWorld: (name, api) => { globalThis[name] = api; },
};

const net = { isOnline: () => globalThis.navigator ? globalThis.navigator.onLine !== false : true };

// There is NO keychain in a browser and this is NOT encryption. isEncryptionAvailable() answers true only so the
// rooms core keeps its one stored value, the session FLAG in web/session-marker.js ("this browser holds a session"),
// across a reload; encryptString/decryptString are plain text. Nothing secret passes through here: the sign-in is
// the engine's HttpOnly cookie, which page code never sees. The web docs must not call this storage encrypted.
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'web-session-marker',
  setUsePlainTextEncryption() {},
  encryptString: (s) => require('./buffer').Buffer.from(String(s)),
  decryptString: (b) => require('./buffer').Buffer.from(b).toString('utf8'),
};

const platformOnly = (what) => () => { throw rt.platformOnly(what); };
const dialog = { showOpenDialog: platformOnly('dialog.showOpenDialog'), showSaveDialog: platformOnly('dialog.showSaveDialog') };
function BrowserWindow() { throw rt.platformOnly('BrowserWindow'); }
const app = { getPath: () => '/', getVersion: () => rt.version() };

module.exports = { ipcMain, ipcRenderer, contextBridge, net, safeStorage, dialog, BrowserWindow, app };
