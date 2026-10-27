// CLI Manager (first-party, class cli-manager): owns the Dashboard tab, the grid of CLI panes.
// P1: the pane engine itself still lives in the core renderer; this module is how the Dashboard
// reaches the top bar (through the Module API, like any other module). The engine moves behind
// this module in later phases. See the design notes.

export async function activate(api) {
  await api.ui.registerTab({ id: 'dashboard', label: 'Terminals', icon: 'dashboard', surface: 'grid' }); // 0.12.5: "Terminals" (the owner )
  api.log('activated');
}
