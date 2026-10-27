'use strict';
// One Rooms client (cookies, caches, drafts, sockets) per account. The IPC dispatcher chooses at
// entry and discards replies after a selection change; terminal minters carry their original owner.
const { ipcMain } = require('electron');
const path = require('path');
const core = require('./index');
function init(ctx) {
  const clients = new Map();
  const applied = new Map(); // account id -> the Workrooms address last applied to its client (chunk 5)
  const handles = new Set(), events = new Set();
  const historyCalls = new Set(['rooms:history-get', 'rooms:history-set', 'rooms:history-export', 'rooms:history-start', 'rooms:history-cancel']);
  let selected = ctx.accounts?.activeId() || null;
  let selectionVersion = ctx.accounts?.selectionVersion() || 0;
  const scope = () => ({ accountId: ctx.accounts?.activeId() || null, selectionVersion: ctx.accounts?.selectionVersion() || 0 });
  const matches = (wanted) => {
    const now = scope();
    return wanted && Number.isSafeInteger(wanted.selectionVersion) && wanted.selectionVersion >= 0 &&
      wanted.accountId === selected && wanted.accountId === now.accountId && wanted.selectionVersion === now.selectionVersion;
  };
  const refused = () => ({ ok: false, code: 'account-changed', why: 'account-changed' });
  const valid = (id) => id === null || !!ctx.accounts?.has(id);
  function client(id) {
    if (!valid(id)) return null;
    const old = clients.get(id);
    if (old?.bound && !old.bound.has()) { old.api.forget(); clients.delete(id); }
    if (clients.has(id)) return clients.get(id);
    const handlers = new Map(), listeners = new Map();
    const bound = id ? ctx.accounts.forAccount(id) : null;
    const ipc = {
      handle(channel, fn) {
        if (channel.startsWith('rooms:history-') && !historyCalls.has(channel)) throw new Error('Unsupported history call');
        handlers.set(channel, fn);
        if (handles.has(channel)) return;
        handles.add(channel);
        ipcMain.handle(channel, async (event, envelope) => {
          const wanted = envelope?.scope;
          if (!matches(wanted) || !Array.isArray(envelope.args)) return refused();
          const c = client(wanted.accountId); // bind the authenticated owner before any await
          if (!c || (c.bound && !c.bound.has())) return refused();
          const result = await c.handlers.get(channel)(event, ...envelope.args);
          if (!matches(wanted) || clients.get(wanted.accountId) !== c || (c.bound && !c.bound.has())) return refused();
          return channel === 'rooms:status' ? { ...result, ...scope() } : result;
        });
      },
      on(channel, fn) {
        listeners.set(channel, fn);
        if (events.has(channel)) return;
        events.add(channel);
        ipcMain.on(channel, (event, envelope) => {
          if (!matches(envelope?.scope) || !Array.isArray(envelope.args)) return;
          client(envelope.scope.accountId)?.listeners.get(channel)?.(event, ...envelope.args);
        });
      },
    };
    const generation = {};
    const server = (ctx.serverFor && ctx.serverFor(id)) || ctx.server;
    applied.set(id, server);
    const api = core.init({ ...ctx, accountId: id, server, ipcMain: ipc, localMode: ctx.localMode === true && id === null,
      scratchpad: ctx.scratchpadFor?.(id, () => clients.get(id)?.generation === generation &&
        valid(id) && selected === id && scope().accountId === id && (!bound || bound.has())),
      dir: id ? path.join(ctx.dir, 'accounts', id, 'rooms') : ctx.dir,
      realm: bound ? { present: () => bound.has(), ticket: () => bound.engineTicket(), signedInAt: () => bound.signedInAt() } : ctx.realm,
      broadcast: (channel, payload) => {
        if (valid(id) && selected === id && scope().accountId === id && (!bound || bound.has())) ctx.broadcast(channel, { ...payload, ...scope(), accountId: id });
      },
    });
    const c = { api, handlers, listeners, bound, generation };
    clients.set(id, c);
    return c;
  }
  client(selected);
  /** Chunk 5: give every account's client the address its account now resolves to; only a changed one switches. */
  function applyAddresses() {
    if (!ctx.serverFor) return;
    for (const [id, c] of clients) {
      const url = ctx.serverFor(id);
      if (url && applied.get(id) !== url) {
        applied.set(id, url);
        c.api.setServer(url, { switch: true });
      }
    }
  }
  function accountChanged() {
    const next = ctx.accounts?.activeId() || null;
    const version = scope().selectionVersion;
    if (next !== selected || version !== selectionVersion) {
      selectionVersion = version;
      clients.get(selected)?.api.deactivate();
      selected = next;
      const c = client(next);
      ctx.broadcast('rooms:account', scope());
      c.api.activate();
    } else client(selected).api.accountChanged();
  }
  return new Proxy({
    accountChanged,
    applyAddresses,
    status: () => ({ ...client(selected).api.status(), ...scope() }),
    signedOut(id) {
      clients.get(id)?.api.forget();
      clients.delete(id);
      applied.delete(id);
      accountChanged();
    },
    forAccount: (id) => client(id)?.api || null,
    /** S3: a module window's request goes to the client of the account main captured as its owner, only while that
     *  account is still selected with the same selection version; a reply after a switch is dropped (revision 9, R9.2). */
    async tasksBound(s, verb, input) {
      const wanted = s && typeof s === 'object' ? { accountId: s.accountId === undefined ? undefined : s.accountId, selectionVersion: s.selectionVersion } : null;
      if (!matches(wanted)) return refused();
      const c = clients.get(wanted.accountId);
      if (!c || (c.bound && !c.bound.has())) return refused();
      const r = await c.api.tasksBound(s, verb, input);
      if (!matches(wanted) || clients.get(wanted.accountId) !== c || (c.bound && !c.bound.has())) return refused();
      return r;
    },
    tasksRoom: (accountId, roomId) => (accountId === selected && scope().accountId === accountId ? clients.get(selected)?.api.tasksRoom(roomId) ?? null : null),
    tasksEpoch: () => clients.get(selected)?.api.tasksEpoch() ?? null,
    tasksRoomTasksPanel: (accountId, roomId) => (accountId === selected && scope().accountId === accountId ? !!clients.get(selected)?.api.tasksRoomTasksPanel(roomId) : false),
    stop: () => { for (const c of clients.values()) c.api.deactivate(); },
  }, { get: (target, key) => key in target ? target[key] : client(selected)?.api[key] });
}
module.exports = { init };
