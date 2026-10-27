// Presentation rules only. The host supplies effective OS paths and performs all I/O.
export const ATTACH_UNAVAILABLE = "Attaching files isn't available in local rooms yet.";
export const FOLDER_MESSAGES = Object.freeze({
  writable: "Agent Workbench can't write to that folder. Choose another.",
  system: 'Choose a folder in your Documents or another place you own.',
  nonempty: "That folder already has files. Agent Workbench adds its own folders and won't change yours.",
  synced: 'This folder is synced. Files here sync like any others.',
  onlineOnly: 'Some files are online-only. Agents may be slow to read them.',
});
export function folderMessages(checks = {}) {
  checks ||= {};
  const rows = [];
  if (checks.system) rows.push({ level: 'error', text: FOLDER_MESSAGES.system });
  if (checks.writable === false) {
    // The Node code and the step that failed, only when both are plain (never a path or message text).
    const plain = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(checks.code || '') && /^[a-z]{1,12}$/.test(checks.step || '');
    rows.push({ level: 'error', text: FOLDER_MESSAGES.writable + (plain ? ` (Code ${checks.code} at ${checks.step}.)` : '') });
  }
  if (checks.nonempty) rows.push({ level: 'info', text: FOLDER_MESSAGES.nonempty });
  if (checks.synced) rows.push({ level: 'info', text: FOLDER_MESSAGES.synced });
  if (checks.onlineOnly) rows.push({ level: 'warning', text: FOLDER_MESSAGES.onlineOnly });
  return rows;
}
export const folderAllowed = checks => checks?.writable === true && !checks.system;
export function roomPlaces(state) {
  return [{ id: 'local', name: 'This computer', icon: 'computer', detail: 'Stays on this computer. Works offline.' },
    ...(state.servers || []).map(server => ({ id: server.id, name: server.name, icon: 'dns', color: validServerColor(server.color),
      detail: `Shared on ${server.name}. Available on your other computers.` }))];
}
export const validServerColor = color => /^#[0-9a-f]{6}$/i.test(color || '') ? color : null;
export function historyFolder(files) {
  const separator = files.separator === '\\' ? '\\' : '/';
  return files.path.replace(/[\\/]+$/, '') + [ '', 'rooms', '…', 'history' ].join(separator);
}
export function uninstallWords(count, path) {
  return {
    title: 'Uninstall Agent Workbench',
    running: count === 1 ? "Agent Workbench is open with 1 CLI. It'll end when Agent Workbench is removed."
      : count > 1 ? `Agent Workbench is open with ${count} CLIs. They'll end when it's removed.` : '',
    body: 'Agent Workbench will be removed from this computer.',
    checkbox: 'Also remove my chats, settings and keys',
    helper: `Stored in the app's data folder. Your files in ${path} are kept.`,
  };
}

/** "Copied 120 of 3,400 files": counts only, from the setup's progress; '' when it is not a plain count. */
export function copyProgressWords(progress) {
  const done = progress?.done, total = progress?.total;
  if (!Number.isInteger(done) || !Number.isInteger(total) || total < 1 || done < 0 || done > total) return '';
  return `Copied ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? 'file' : 'files'}`;
}
