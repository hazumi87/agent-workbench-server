/* LOCAL MODE: stdout belongs to the supervisor. It carries ONE line, the ready JSON; everything the engine logs goes to stderr
 * instead. Imported FIRST by server/index.ts (ESM runs imports in order), so no module logs to stdout before this runs.
 * Inert unless HARBOR_WB_MODE=local. */
if ((process.env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local') {
  /* the app owns every window: force the engine's desktop off, whatever the environment says (also enforced in desktop-actions chooseMode) */
  process.env.HARBOR_WB_DESKTOP = 'none';
  process.env.HARBOR_WB_NO_WINDOW = '1';
  console.log = (...args: unknown[]): void => console.error(...args);
  console.info = console.log;
  console.debug = console.log;
}
export {};
