'use strict';
// A tiny fs for the rooms core in the browser: the per-device files it keeps (rooms.secrets, rooms-auto.json,
// rooms-connections.json). Text only, kept in localStorage under one key. The "secret" file holds only a
// marker that a browser session exists: the cookie itself is HttpOnly and never reaches this code, so
// nothing here is a credential. If localStorage is unavailable the files live for this page only.
const { Buffer } = require('./buffer');

const KEY = 'wb-web-fs';
let files = null;

function load() {
  if (files) return files;
  files = new Map();
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(KEY) || '{}');
    for (const [p, text] of Object.entries(saved)) if (typeof text === 'string') files.set(p, text);
  } catch (e) { /* page-only */ }
  return files;
}
function save() {
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(load()))); } catch (e) { /* page-only */ }
}
const enoent = (p) => Object.assign(new Error('ENOENT: no such file, ' + p), { code: 'ENOENT' });

function readFileSync(p, options) {
  const text = load().get(String(p));
  if (text === undefined) throw enoent(p);
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  return encoding ? text : Buffer.from(text);
}
function writeFileSync(p, data) {
  load().set(String(p), typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  save();
}
function mkdirSync() { /* flat store: nothing to make */ }
function rmSync(p, options) {
  const had = load().delete(String(p));
  if (!had && !(options && options.force)) throw enoent(p);
  save();
}
function existsSync(p) { return load().has(String(p)); }
function statSync(p) {
  const text = load().get(String(p));
  if (text === undefined) throw enoent(p);
  return { size: new TextEncoder().encode(text).length, isFile: () => true, isDirectory: () => false };
}
// test hook: forget everything held in memory (and the stored copy)
function _reset() { files = new Map(); try { globalThis.localStorage.removeItem(KEY); } catch (e) { /* none */ } }

module.exports = { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, _reset };
