// The app-header widget list's model (the design notes W1 and revision 1 P1). Pure: one row per bundled,
// enabled widget module holding ui.widget, times each node, by module name then node order. A node that doesn't
// exist yet is listed, disabled and never checked; checked follows the open set (module|node keys). The host
// draws the button and the menu from these rows. test/widget-list.test.mjs.

const NODE_ID = /^[a-z0-9-]{1,32}$/;
const ICON = /^[a-z0-9_]{1,40}$/; // a Material Symbols name, as main's scan
const MAX_NAME = 60;

export const keyOf = (moduleId, node) => moduleId + '|' + node;

const listed = (m) => !!m && m.class === 'widget' && m.source === 'bundled' && m.enabled === true && !m.error &&
  Array.isArray(m.permissions) && m.permissions.includes('ui.widget') && !!m.widget && typeof m.widget === 'object';

/** catalog: main's module entries · nodes: [{id, name, exists}] · open: keys of the open widgets. */
export function widgetRows(catalog, nodes, open) {
  const isOpen = new Set(open || []);
  const seen = new Set();
  const ns = (Array.isArray(nodes) ? nodes : []).filter((n) => {
    if (!n || typeof n.id !== 'string' || !NODE_ID.test(n.id) || seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  const mods = (Array.isArray(catalog) ? catalog : []).filter(listed)
    .map((m) => ({ id: m.id, name: String(m.name || m.id).slice(0, MAX_NAME), icon: typeof m.icon === 'string' && ICON.test(m.icon) ? m.icon : 'extension' }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const rows = [];
  for (const m of mods) {
    for (const n of ns) {
      const key = keyOf(m.id, n.id);
      const disabled = n.exists !== true;
      rows.push({ key, moduleId: m.id, node: n.id, label: m.name + ' · ' + String(n.name || n.id).slice(0, MAX_NAME), icon: m.icon, checked: !disabled && isOpen.has(key), disabled });
    }
  }
  return rows;
}

/** Choosing a row: open an unchecked one, close a checked one; a disabled row does nothing. */
export function chooseRow(row) {
  if (!row || row.disabled) return null;
  return row.checked ? { close: row.key } : { open: { moduleId: row.moduleId, node: row.node } };
}

/** A key inside the open menu → the row index to focus, 'close', or null. */
export function menuKey(index, key, count) {
  if (key === 'Escape') return 'close';
  if (!count) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
