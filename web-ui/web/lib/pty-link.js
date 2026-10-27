'use strict';
// The page's one socket to the engine's terminal door, WS /pty (the engine's own pages use it the same way: web/transport.mjs).
// One socket for every pane, the pane id in every frame; the sign-in cookie rides the upgrade (a browser sends it on its own
// origin), so there is no grant and no token in the page. Owner: a builder. Pure: the WebSocket class, the clock and the
// URL are injected, so the same code runs in the page and in the real-engine test.
//   - liveness: a JSON ping every PING_MS; nothing at all for DEAD_MS means the flow is dead, so close it (a socket that stalls never closes itself)
//   - reconnect: after RECONNECT_MS, forever, until close()
//   - the outbox holds only what is safe to send late (attach, resize, attention). Typed input is NEVER queued: send() says
//     false and the caller shows "typing paused", because keystrokes replayed later reach a screen the person is not looking at.
const PING_MS = 10000;
const DEAD_MS = 30000;
const RECONNECT_MS = 1000;
const QUEUEABLE = new Set(['attach', 'resize', 'attention.ack', 'ping']);

function createLink({ url, WebSocketImpl = globalThis.WebSocket, timers, onFrame = () => {}, onStatus = () => {} }) {
  const T = timers || { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (t) => globalThis.clearTimeout(t), setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (t) => globalThis.clearInterval(t), now: () => Date.now() };
  let ws = null;
  let status = 'connecting';
  let stopped = false;
  let beat = null;
  let retry = null;
  let lastInbound = 0;
  const outbox = [];
  const setStatus = (s) => { if (s !== status) { status = s; onStatus(s); } };
  const OPEN = (WebSocketImpl && WebSocketImpl.OPEN) || 1;

  function stopBeat() { if (beat) { T.clearInterval(beat); beat = null; } }
  function startBeat() {
    stopBeat();
    lastInbound = T.now();
    beat = T.setInterval(() => {
      if (!ws || ws.readyState !== OPEN) return;
      if (T.now() - lastInbound > DEAD_MS) { try { ws.close(); } catch (e) { /* going */ } return; } // one recovery route: the close handler reconnects
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* the close handler will see it */ }
    }, PING_MS);
  }

  function connect() {
    if (stopped) return;
    let s;
    try { s = new WebSocketImpl(typeof url === 'function' ? url() : url); } catch (e) { retry = T.setTimeout(connect, RECONNECT_MS); setStatus('closed'); return; }
    ws = s;
    s.onopen = () => {
      if (ws !== s) return;
      startBeat();
      setStatus('open');
      while (outbox.length && ws.readyState === OPEN) ws.send(JSON.stringify(outbox.shift()));
    };
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      stopBeat();
      setStatus('closed');
      if (!stopped) retry = T.setTimeout(connect, RECONNECT_MS);
    };
    s.onerror = () => { try { s.close(); } catch (e) { /* closing */ } };
    s.onmessage = (ev) => {
      if (ws !== s) return;
      lastInbound = T.now(); // any traffic proves the flow, before the parse
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || msg.type === 'pong') return;
      try { onFrame(msg); } catch (e) { /* a consumer's error never kills the link */ }
    };
  }
  connect();

  return {
    /** true: sent now. false: not open (only a queueable frame is kept for when it opens). */
    send(frame) {
      if (ws && ws.readyState === OPEN) { ws.send(JSON.stringify(frame)); return true; }
      if (frame && QUEUEABLE.has(frame.type)) {
        // a newer resize or attach for a pane replaces the older one: the outbox never grows with stale ones
        for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === frame.type && outbox[i].paneid === frame.paneid) outbox.splice(i, 1);
        outbox.push(frame);
      }
      return false;
    },
    get status() { return status; },
    get open() { return !!ws && ws.readyState === OPEN; },
    close() { stopped = true; stopBeat(); if (retry) T.clearTimeout(retry); try { if (ws) ws.close(); } catch (e) { /* closed */ } ws = null; },
    _outbox: outbox,
  };
}

module.exports = { createLink, PING_MS, DEAD_MS, RECONNECT_MS };
