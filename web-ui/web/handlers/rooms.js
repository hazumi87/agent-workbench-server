'use strict';
// Rooms: the REAL src/rooms core (scoped wrapper, cache, line merge, disconnected-room fence, the live
// socket with backfill) running in the page behind the shims, so there is ONE implementation of that
// state, the desktop's. Owner of the group from here on: a builder (overrides for the native
// pieces: rooms:pick-files, rooms:download, rooms:open-window; the module-page task calls stay todo).
const scoped = require('rooms-scoped');
const rt = require('../runtime');
const native = require('../lib/native-browser');

function register(api) {
  const origin = globalThis.location ? globalThis.location.origin : '';
  const tasks = {
    // module-page task calls need the module host (a later slice): refuse, never fake an admission
    fromAppPage: () => false,
    admit: () => false,
    approvals: { mint: () => null },
  };
  scoped.init({
    accounts: undefined, // one person per server: no accounts, so the selection is {accountId:null, selectionVersion:0}
    localMode: false,
    dir: '/wb-web',
    server: origin,
    serverFor: () => origin,
    serverName: (globalThis.location && globalThis.location.host) || '',
    realm: null,
    cause: () => {},
    tasks,
    native, // rooms:pick-files / rooms:download / rooms:open-window: the browser's own chooser, download and a tab on the engine's raw route
    broadcast: (channel, payload) => rt.emit(channel, payload),
  });
}

module.exports = { register };
