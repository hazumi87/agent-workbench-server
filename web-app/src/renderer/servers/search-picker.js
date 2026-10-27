import { el } from '../rooms/line.js';

let sequence = 0;

/** Search is display text; only choosing one of the supplied options produces an ID. */
export function createSearchPicker({ label, name, options, current, onChange }) {
  const root = el('div', 'sv-field sv-picker');
  const title = el('label', null, label);
  const input = el('input');
  input.type = 'text'; input.name = name; input.id = 'sv-pick-' + ++sequence;
  input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = name === 'person' ? 'Search by name or email' : 'Search logins';
  title.htmlFor = input.id;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const list = el('div', 'sv-picklist'); list.id = input.id + '-list'; list.hidden = true;
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label);
  input.setAttribute('aria-controls', list.id);
  root.append(title, input, list);
  let selected = null, filtered = [], at = -1, alive = true;
  const valid = () => alive && current();
  const value = () => valid() && selected && input.value === selected.label ? selected.id : null;
  function close() {
    list.hidden = true; at = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function choose(option) {
    if (!valid() || !options.includes(option)) return;
    selected = option; input.value = option.label; close(); onChange();
  }
  function mark() {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === at)));
    const active = list.children[at];
    if (active) { input.setAttribute('aria-activedescendant', active.id); active.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function show() {
    if (!valid()) { close(); return; }
    const query = input.value.trim().toLocaleLowerCase();
    filtered = options.filter(option => (option.search || option.label).toLocaleLowerCase().includes(query));
    at = -1; list.replaceChildren();
    for (const [index, option] of filtered.entries()) {
      const row = el('div', 'sv-pickoption', option.label); row.id = list.id + '-' + index;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
      row.addEventListener('pointerdown', e => e.preventDefault());
      row.addEventListener('click', () => choose(option));
      list.appendChild(row);
    }
    if (!filtered.length) list.appendChild(el('div', 'sv-pickempty', 'No matches'));
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
  }
  input.addEventListener('input', () => { selected = null; show(); onChange(); });
  input.addEventListener('focus', show);
  input.addEventListener('blur', close);
  // Register before the dialog's capture handler: choosing a suggestion with Enter
  // must finish the picker before the dialog can consider submitting the form.
  const onKey = e => {
    if (e.target !== input || !valid()) return;
    if (e.isComposing || e.keyCode === 229) { e.stopImmediatePropagation(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (e.key === 'Escape' && list.hidden) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
    if (e.key === 'Enter' && list.hidden) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { close(); return; }
    if (list.hidden) show();
    if (e.key === 'Enter') { if (at >= 0) choose(filtered[at]); return; }
    if (!filtered.length) return;
    at = (at + (e.key === 'ArrowDown' ? 1 : at < 0 ? 0 : -1) + filtered.length) % filtered.length;
    mark();
  };
  document.addEventListener('keydown', onKey, true);
  return { el: root, input, list, value, destroy() { alive = false; close(); document.removeEventListener('keydown', onKey, true); } };
}
