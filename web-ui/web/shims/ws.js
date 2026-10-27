'use strict';
// `ws` for the browser: the node-style surface live.js uses (on, send, close, terminate, emit, readyState,
// WebSocket.OPEN) over the native WebSocket. The cookie goes with the same-origin handshake; node's
// per-request headers do not exist here and are ignored.
class WebSocket {
  constructor(url) {
    this._handlers = new Map();
    this._ws = new globalThis.WebSocket(url);
    this._ws.addEventListener('open', () => this.emit('open'));
    this._ws.addEventListener('message', (ev) => this.emit('message', ev.data));
    this._ws.addEventListener('close', () => this.emit('close'));
    this._ws.addEventListener('error', () => this.emit('error', new Error('websocket error')));
  }
  get readyState() { return this._ws.readyState; }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(fn);
    return this;
  }
  emit(type, ...args) {
    for (const fn of this._handlers.get(type) || []) fn(...args);
    return true;
  }
  send(data) { this._ws.send(data); }
  close() { try { this._ws.close(); } catch (e) { /* gone */ } }
  terminate() { this.close(); }
}
WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;
module.exports = { WebSocket };
