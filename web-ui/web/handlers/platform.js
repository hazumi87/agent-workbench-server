'use strict';
// The substitute channels with a browser equivalent of the same contract, plus the main-process
// bookkeeping channels that have no meaning in a page. Owner: a builder (the foundation).
// Every row here is classed `substitute` in web/channel-map.json; the build fails if one has no handler.

const KNOWN = new Set(['system', 'light', 'dark']);

function register(api) {
  // ---- bookkeeping with no web meaning: quiet no-ops (sends)
  for (const channel of ['pane:active', 'win:mode', 'win:closeEmpty', 'startup:done', 'state:report', 'debug:log', 'debug:set', 'modules:theme']) {
    api.on(channel, () => {});
  }
  // the page's colour scheme follows the person's choice the way nativeTheme does for the window
  api.handle('window:theme', async ([theme]) => {
    if (!KNOWN.has(theme)) return false;
    const root = globalThis.document && globalThis.document.documentElement;
    if (root) root.style.colorScheme = theme === 'system' ? '' : theme;
    return true;
  });

  // update:state: the web build has no updater; the About page and the boot read this and must get a true answer
  api.handle('update:state', async () => ({ ready: null, available: null, auto: false, version: String((globalThis.__WB_WEB__ || {}).version || '') }));

  // clipboard:write and shell:open-external are owned by browser-actions.js.

  // machine:info: the CLIs run on the ENGINE host, whose OS and shell the browser cannot know (a Windows browser
  // must not be told "Windows" and "bash"). Only the address the page was loaded from is true; the rest is unknown.
  api.handle('machine:info', async () => ({
    name: String((globalThis.location && globalThis.location.hostname) || ''),
    os: '', release: '', shell: '',
  }));
}

module.exports = { register };
