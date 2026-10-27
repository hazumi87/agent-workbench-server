'use strict';
// Rooms (W1): the live half, a WebSocket on the engine's /pty. That socket can also drive terminals, so
// this client is deliberately narrow (the PM's ruling , 3): OUTGOING only `room.subscribe` and
// `ping` (anything else throws before it is sent); INCOMING only the room.* events and `pong`; every
// other frame type is dropped unparsed, counted, and never logged with its content.
// Heartbeat and resume per ROOMS-API.md §2.4-2.5: a JSON ping every 10 s, 30 s of silence closes the
// socket, there is no resume token (the owner re-subscribes and backfills after every open).

const { WebSocket } = require('ws');
const { frameBytesOk, tasksBroadcast } = require('./task-events.js');

const SEND_ALLOWED = new Set(['room.subscribe', 'ping']);
const RECV_ALLOWED = new Set(['room.subscribed', 'room.line', 'room.state', 'room.read', 'room.held', 'room.waiting', 'room.scratchpad', 'room.tasks', 'pong']); // room.tasks: Tasks seam S5, ids only, at most 1 KB
const PING_MS = 10000;
const SILENCE_MS = 30000;
const SUBSCRIBE_WAIT_MS = 3000;

/**
 * createLive({ url: () => wss url, cookie: () => cookie header, onEvent(msg), onOpen(), onClose(why) })
 * .connect() opens one socket; .close() ends it; .subscribe(ids) replaces the followed set;
 * .send(msg) is the allowlisted door; .counts() = { dropped, received }.
 */
function createLive(deps) {
  let ws = null;
  let pingTimer = null;
  let silenceTimer = null;
  let subTimer = null;
  let lastRooms = [];
  let subscribed = false;
  const counts = { dropped: 0, received: 0, sent: 0 };

  function clearTimers() {
    clearInterval(pingTimer);
    clearTimeout(silenceTimer);
    clearTimeout(subTimer);
    pingTimer = null;
    silenceTimer = null;
    subTimer = null;
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // nothing heard for 30 s: the owner reconnects
      endSocket('silence');
    }, SILENCE_MS);
  }

  function endSocket(why) {
    const s = ws;
    ws = null;
    subscribed = false;
    clearTimers();
    if (s) {
      try {
        s.terminate();
      } catch (e) {
        // gone
      }
      if (deps.onClose) {
        deps.onClose(why);
      }
    }
  }

  function send(msg) {
    const type = msg && typeof msg === 'object' ? msg.type : null;
    if (!SEND_ALLOWED.has(type)) {
      throw new Error('rooms: a frame of type ' + JSON.stringify(type) + ' is not allowed out of the room client');
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(msg));
    counts.sent += 1;
    return true;
  }

  function subscribe(ids) {
    lastRooms = Array.isArray(ids) ? ids.map(String) : [];
    return send({ type: 'room.subscribe', rooms: lastRooms });
  }

  function connect() {
    if (ws) {
      return;
    }
    const url = deps.url();
    if (!url) {
      return;
    }
    const headers = {};
    const ck = deps.cookie ? deps.cookie() : '';
    if (ck) {
      headers.cookie = ck;
    }
    let s;
    try {
      s = new WebSocket(url, { headers, handshakeTimeout: 10000 });
    } catch (e) {
      if (deps.onClose) {
        deps.onClose('error');
      }
      return;
    }
    ws = s;
    s.on('open', () => {
      if (ws !== s) {
        return;
      }
      armSilence();
      pingTimer = setInterval(() => {
        try {
          send({ type: 'ping' });
        } catch (e) {
          // the allowlist cannot refuse a ping
        }
      }, PING_MS);
      // the followed set died with the old socket: send it again, and expect the echo within 3 s
      subscribe(lastRooms);
      subTimer = setTimeout(() => {
        if (ws === s && !subscribed) {
          endSocket('no-subscribed');
        }
      }, SUBSCRIBE_WAIT_MS);
    });
    s.on('message', (data) => {
      if (ws !== s) {
        return;
      }
      armSilence();
      let type = null;
      let msg = null;
      try {
        // the type is read first; a frame of another type is dropped before anything else is looked at
        const text = String(data);
        const m = /"type"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/.exec(text.slice(0, 200));
        type = m ? m[1] : null;
        if (!RECV_ALLOWED.has(type) || (type === 'room.tasks' && !frameBytesOk(text))) {
          counts.dropped += 1;
          return;
        }
        msg = JSON.parse(text);
      } catch (e) {
        counts.dropped += 1;
        return;
      }
      if (!msg || msg.type !== type) {
        counts.dropped += 1;
        return;
      }
      counts.received += 1;
      if (type === 'room.subscribed') {
        subscribed = true;
        clearTimeout(subTimer);
        if (deps.onOpen) {
          deps.onOpen(Array.isArray(msg.rooms) ? msg.rooms : []);
        }
        return;
      }
      if (type === 'pong') {
        return;
      }
      if (deps.onEvent) {
        deps.onEvent(msg);
      }
    });
    s.on('close', () => {
      if (ws === s) {
        endSocket('closed');
      }
    });
    s.on('error', () => {
      if (ws === s) {
        endSocket('error');
      }
    });
  }

  return {
    connect,
    close: () => endSocket('client'),
    subscribe,
    send,
    counts: () => ({ ...counts }),
    isOpen: () => !!ws && ws.readyState === WebSocket.OPEN && subscribed,
    // self-test only: a frame handed to the parser as if the engine sent it
    _inject: process.env.WB_SELFTEST ? (text) => ws && ws.emit('message', text) : undefined,
  };
}

module.exports = { createLive, SEND_ALLOWED, RECV_ALLOWED, tasksBroadcast }; // tasksBroadcast re-exported for rooms/index.js (S5)
