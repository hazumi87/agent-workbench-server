// Does this engine offer a bare shell? A hosted engine does not (it spawns programs directly, never a shell). The engine says so in GET /api/settings/setup
// (hosted / bareShell, read by the web handler wb.web.capabilities); an engine that says nothing is treated as before: a bare shell is offered.
/** true only when the engine said it does not open a bare shell. */
export const bareShellOff = () => {
  const c = window.wb && window.wb.web && window.wb.web.capabilities;
  return !!(c && typeof c.bareShell === 'function' && c.bareShell() === false);
};
/** The engine's built-in bare-shell recipe (and any recipe of the Shell program). */
export const isBareShellRecipe = (v) => !!v && (v.programId === 'shell' || v.vendor === 'cli-manager');
