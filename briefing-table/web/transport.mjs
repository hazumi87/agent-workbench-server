/* Shared {send, on} transport adapter — the renderer half of the multiplexed
 * WS seam (the design notes). Extracted for the CLI Manager
 * pages (solo.js); workbench.js keeps its own inline copy untouched (zero
 * regression risk on the deferred workbench surface — they can converge when
 * that track resumes). ONE socket, paneid in every body, engine-owned
 * reconnect with a queued outbox. */

export function createTransport() {
  let ws = null;
  let status = 'connecting';
  const handlers = new Map(); // type -> Set<fn>
  const statusFns = new Set();
  const outbox = []; // commands queued while the socket is down
  let stopped = false; // close(): this page has let go of the session for good

  function emitStatus(s) {
    status = s;
    for (const fn of statusFns) {
      fn(s);
    }
  }

  /* LIVENESS, because a socket that STALLS never closes itself.
   *
   * A blackholed TCP flow — what a NAT or Tailscale rebind does to one
   * connection — leaves `readyState === OPEN` forever. `send()` succeeds, the
   * kernel buffers, and nothing arrives. Owner lost five minutes to it: the pane
   * looked connected, other tabs were fine (their own flows were healthy), and
   * when the path recovered TCP delivered the backlog in order, so every
   * keystroke he had typed appeared at once.
   *
   * SILENCE IS NOT EVIDENCE — an idle session sends nothing for minutes — so we
   * ASK. A ping every PING_MS, and if nothing at all has arrived for DEAD_MS we
   * stop believing the socket and close it, which turns an invisible stall into
   * an ordinary reconnect: status goes to `closed`, the page paints
   * disconnected, and input QUEUES in the outbox instead of being written into
   * a void.
   *
   * DEAD_MS is deliberately a multiple of PING_MS, so a single dropped ping
   * cannot condemn a healthy socket. */
  const PING_MS = 10_000;
  const DEAD_MS = 30_000;
  let lastInbound = 0;
  let beat = null;

  function stopBeat() {
    if (beat) {
      clearInterval(beat);
      beat = null;
    }
  }

  function startBeat() {
    stopBeat();
    lastInbound = Date.now();
    beat = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (Date.now() - lastInbound > DEAD_MS) {
        /* Not closed, not delivering: give up on it deliberately. `onclose`
           then drives the normal reconnect path, so there is ONE recovery
           route rather than a second one that only stalls take. */
        try {
          ws.close();
        } catch {
          /* already going */
        }
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* the close handler will pick it up */
      }
    }, PING_MS);
  }

  function connect() {
    /* Scheme MUST follow the page: a page served over https cannot open a ws://
       socket — the browser blocks it as mixed content (found live behind
       Tailscale Serve, 2026-08-19). location.host already carries the port. */
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty`);
    ws.onopen = () => {
      startBeat();
      emitStatus('open');
      while (outbox.length) {
        ws.send(JSON.stringify(outbox.shift()));
      }
    };
    ws.onclose = () => {
      stopBeat();
      emitStatus('closed');
      if (!stopped) {
        setTimeout(connect, 1000);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    ws.onmessage = (ev) => {
      /* ANY traffic proves the flow, including a pong — recorded before the
         parse so a malformed frame still counts as the socket being alive. */
      lastInbound = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        return; // liveness only; nothing downstream subscribes to it
      }
      const set = handlers.get(msg.type);
      if (set) {
        for (const fn of set) {
          fn(msg);
        }
      }
    };
  }

  connect();

  return {
    send(command) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(command));
      } else {
        outbox.push(command);
      }
    },
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    onStatus(fn) {
      statusFns.add(fn);
      fn(status);
    },
    get status() {
      return status;
    },
    /** Let go of the socket and never reconnect (the page stops being a
     *  viewer: a window told to close that cannot close itself). */
    close() {
      stopped = true;
      stopBeat();
      try {
        ws?.close();
      } catch {
        /* already going */
      }
    },
  };
}
