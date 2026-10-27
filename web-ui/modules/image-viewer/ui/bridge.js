// The frame side of a module page's bridge (the design notes R2 and revision 7; web: the design notes
// §3). In a frame the page first asks for its port with {wbHello: <its own wbl nonce>}; the host
// then transfers ONE MessagePort with the handshake {wbBridge: 1}; that port is the frame's only identity, and any
// later port is ignored. Requests go out as {id, verb, input} (at most MAX_INFLIGHT at
// once); replies come back as {id, ok:true, body} or {id, ok:false, kind:'refused'|'transport'|'revoked',
// ...}. The host may also post {event, payload}. The page never learns a room, module or account from
// here: the host takes those from its binding. The same file ships in modules/tasks/ui and
// modules/usage/ui (a module page can load only its own files); a test keeps the copies identical.

export const MAX_INFLIGHT = 8;

/**
 * The bridge's two control messages, {wbBridge: 1} (the init) and {wbBridge: 'revoked'} (the host ended the
 * view), are accepted only as a PLAIN object (prototype Object.prototype or null) with exactly one own,
 * string-named data property, wbBridge, of exactly that value. Arrays, class instances, other prototypes,
 * getters and extra (symbol or hidden) keys are lookalikes.
 */
export function isMarker(m, value) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const proto = Object.getPrototypeOf(m);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(m);
  if (keys.length !== 1 || keys[0] !== 'wbBridge') return false;
  const d = Object.getOwnPropertyDescriptor(m, 'wbBridge');
  return !!d && Object.prototype.hasOwnProperty.call(d, 'value') && d.value === value;
}

class BridgeError extends Error {
  constructor(kind, message, extra = {}) {
    super(message || kind);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function createBridge(win = globalThis.window) {
  let port = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map(); // id -> { resolve, reject }
  const listeners = new Map(); // event -> Set(fn)
  let markReady;
  const ready = new Promise((r) => { markReady = r; });

  // The host ended this view (revoked, closed, or the page loaded again): every call already sent settles as
  // revoked, later calls are refused, late replies are ignored (a builder's step 4 review).
  function revoked() {
    if (closed) return;
    closed = true;
    win.removeEventListener('message', onWindowMessage);
    for (const p of pending.values()) p.reject(new BridgeError('revoked', 'this view was closed by the app'));
    pending.clear();
    if (port) {
      port.onmessage = null;
      try { port.close(); } catch { /* already closed */ }
    }
  }

  function onReply(e) {
    const m = e.data;
    if (closed || !m || typeof m !== 'object') return;
    if (isMarker(m, 'revoked')) {
      revoked();
      return;
    }
    if (typeof m.event === 'string') {
      for (const fn of listeners.get(m.event) || []) {
        try { fn(m.payload); } catch (err) { /* a page listener's own error */ }
      }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return; // unknown or already settled
    pending.delete(m.id);
    if (m.ok === true) {
      p.resolve(m.body);
    } else if (m.kind === 'refused') {
      p.reject(new BridgeError('refused', typeof m.error === 'string' ? m.error : 'refused', { status: m.status, field: m.field }));
    } else if (m.kind === 'revoked') {
      p.reject(new BridgeError('revoked', 'this view was closed by the app'));
    } else {
      p.reject(new BridgeError('transport', "couldn't reach the app"));
    }
  }

  // Revision 7 C1: exactly one init, from the parent window (never the page itself, another frame, or a
  // page outside a frame), exactly {wbBridge: 1}, exactly one transferred port.
  function onWindowMessage(e) {
    if (port || closed || !e) return; // the first handover only
    // in a frame the host page hands the port in, so the init comes from the parent; in a module window (S3)
    // the page is the top-level document and its push-only preload posts the init to the window itself
    const top = !win.parent || win.parent === win;
    if (top ? e.source !== win : e.source !== win.parent) return;
    if (!isMarker(e.data, 1)) return;
    if (!e.ports || e.ports.length !== 1) return;
    const p = e.ports[0];
    port = p;
    port.onmessage = onReply;
    // where the platform reports the other end closing (Node's MessagePort does), that is a revocation too
    if (typeof port.addEventListener === 'function') port.addEventListener('close', revoked);
    markReady();
  }
  win.addEventListener('message', onWindowMessage);
  // in a frame: ask the host for the port with this load's own nonce; a page without it is never answered
  if (win.parent && win.parent !== win) {
    let nonce = null;
    try { nonce = new URLSearchParams(win.location.search).get('wbl'); } catch { nonce = null; }
    if (nonce) win.parent.postMessage({ wbHello: nonce }, '*'); // '*': the host page's origin is not ours to know
  }

  return {
    ready,
    call(verb, input = {}) {
      if (closed) return Promise.reject(new BridgeError('revoked', 'this view was closed by the app'));
      if (!port) return Promise.reject(new BridgeError('transport', 'not connected yet'));
      if (pending.size >= MAX_INFLIGHT) return Promise.reject(new BridgeError('busy', 'too many requests at once'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ id, verb: String(verb), input: input && typeof input === 'object' ? input : {} });
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    close: revoked,
  };
}
