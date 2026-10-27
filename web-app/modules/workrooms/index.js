// Workrooms stub (first-party, class workrooms): proves the module method. When enabled it is a
// top-bar tab whose surface is the empty page in ui/. Its one setting (the tab label) shows the
// settings-schema path end to end: Global Settings > Modules > Workrooms edits it, the tab follows.

export async function activate(api) {
  const s = await api.settings.get();
  await api.ui.registerTab({ id: 'workrooms', label: s.label, icon: 'apps', surface: 'rooms' }); // W1: the core-drawn Workrooms page (src/renderer/rooms)
  api.events.on('settings.changed', (next) => {
    api.ui.setTab({ id: 'workrooms', label: next.label });
  });
  api.log('activated');
}
