// Workrooms (W3): one M3 dialog over the Workrooms tab, for the asks (Remove, Make lead, Archive, Dissolve, Clear
// the brief) and the small forms (Add a seat, How it runs, Rename, New room, New workgroup). the design's #w3 page:
// a title, a supporting line or the form, then the actions on the right; Esc and the scrim cancel; the first
// field (or the primary action) takes focus; an error line sits above the actions.
import { el } from './line.js';

/**
 * openDialog(host, { title, text?, body?, actions:[{ label, kind:'text'|'filled'|'error', primary?, fn? }] })
 * → { el, close(), busy(on), error(text), enable(label, on) }. An action's fn may return a promise; a resolved
 * false keeps the dialog open (the form shows its error), anything else closes it.
 */
export function openDialog(host, o) {
  const scrim = el('div', 'wr-scrim');
  const d = el('div', 'wr-dlg');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  const t = el('div', 'wr-dlgt', o.title);
  t.id = 'wr-dlgt-' + Math.random().toString(36).slice(2, 8);
  d.setAttribute('aria-labelledby', t.id);
  d.appendChild(t);
  if (o.text) {
    d.appendChild(el('div', 'wr-dlgx', o.text));
  }
  if (o.body) {
    const b = el('div', 'wr-dlgb');
    b.appendChild(o.body);
    d.appendChild(b);
  }
  const err = el('div', 'wr-dlge');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  d.appendChild(err);
  const acts = el('div', 'wr-dlga');
  const buttons = new Map();
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (o.onClose) {
      o.onClose();
    }
  };
  for (const a of o.actions || []) {
    const b = el('button', 'wr-dlgbtn ' + (a.kind || 'text'), a.label);
    b.type = 'button';
    b.disabled = !!a.disabled;
    b.addEventListener('click', async () => {
      if (!a.fn) {
        close();
        return;
      }
      err.hidden = true;
      api.busy(true);
      let r;
      try {
        r = await a.fn();
      } catch (e) {
        r = false;
        api.error(String((e && e.message) || e));
      }
      api.busy(false);
      if (r !== false) {
        close();
      }
    });
    buttons.set(a.label, b);
    acts.appendChild(b);
  }
  d.appendChild(acts);
  scrim.appendChild(d);
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) {
      close();
    }
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && host.querySelector('.wr-pmenu')) {
      return; // a menu open over the dialog (a select field's) closes first
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
      const p = (o.actions || []).find((a) => a.primary);
      const b = p && buttons.get(p.label);
      if (b && !b.disabled) {
        e.preventDefault();
        b.click();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  host.appendChild(scrim);
  requestAnimationFrame(() => {
    const f = buttons.get(o.focus) || d.querySelector('input:not([type=radio]):not([type=checkbox]), textarea, select') || d.querySelector('input[type=radio]:checked') || [...buttons.values()].reverse().find((b) => !b.disabled);
    if (f) {
      f.focus();
    }
  });
  let busyState = false;
  const api = {
    el: d,
    close,
    busy(on) {
      busyState = !!on;
      for (const b of buttons.values()) {
        b.toggleAttribute('data-busy', busyState);
      }
    },
    error(text) {
      err.textContent = text || '';
      err.hidden = !text;
    },
    enable(label, on) {
      const b = buttons.get(label);
      if (b) {
        b.disabled = !on;
      }
    },
    isOpen: () => !closed,
  };
  return api;
}

/** An M3 outlined text field with its label and hint (the forms' fields). */
export function textField({ label, value, hint, name, maxLength }) {
  const f = el('div', 'wr-field wr-dlgf');
  const i = el('input');
  i.type = 'text';
  i.name = name || label.toLowerCase();
  i.id = 'wr-f-' + i.name + '-' + Math.random().toString(36).slice(2, 6);
  i.placeholder = ' ';
  i.value = value || '';
  i.autocomplete = 'off';
  i.spellcheck = false;
  if (maxLength) {
    i.maxLength = maxLength;
  }
  const l = el('label', null, label);
  l.htmlFor = i.id;
  f.append(i, l);
  const wrap = el('div', 'wr-dlgfw');
  wrap.appendChild(f);
  let h = null;
  if (hint) {
    h = el('div', 'wr-dlgh', hint);
    wrap.appendChild(h);
  }
  return { el: wrap, input: i, hint: h };
}

/** A handle as the engine keeps it: letters, numbers, - and _. */
export const HANDLE_RE = /^[A-Za-z0-9_-]{1,40}$/;
