/* THE RESUME PICKER: the RECORDED sessions of one project folder, served by
 * the engine (GET /api/recipes/:id/sessions: name > auto-title, last prompt,
 * age, branch, size). ONE picker for every surface (2026-09-28): the CLI
 * Manager card's Resume and the + sheet's START FROM A PROJECT row both open
 * this, so the two cannot drift. Lifted out of manager.js (it lived there as
 * #resumeModal markup + openResumePicker) rather than copied.
 *
 * What it does NOT do is launch: it answers WHICH session (onPick) or that
 * the user backed out (onCancel), and the caller decides what a pick means —
 * the manager relaunches through POST /api/recipes/:id/launch
 * {resumeSessionId}; the sheet remembers the pick and starts a seat with it.
 *
 * Self-contained: it links its own stylesheet and mounts on document.body
 * above anything else (the + sheet included). Esc / Cancel / a backdrop click
 * cancel. Its key handling is on WINDOW in the capture phase, which runs
 * before a host's document-level handler, so Esc closes the picker and not
 * the sheet under it. Tab stays inside it. Focus goes back to what opened it.
 */

import { focusInto } from '/focus-intent.mjs';

const ELL = String.fromCharCode(8230);
const MDASH = String.fromCharCode(8212);
const MIDDOT = String.fromCharCode(183);

function injectStyles() {
  if (!document.querySelector('link[href*="resume-picker.css"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/resume-picker.css';
    document.head.append(l);
  }
}

export function fmtSize(bytes) {
  if (bytes >= 1048576) { return `${(bytes / 1048576).toFixed(1)}MB`; }
  if (bytes >= 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
  return `${bytes}B`;
}

export function ago(ts) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) { return `${m}m ago`; }
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** A session's human name, by claude's own /resume rules: the title (an
 *  explicit rename, else the auto title), else the last prompt, else the
 *  first slash command (an /exit-only session reads "/exit"), else untitled. */
export function sessionLabel(s) {
  const fallback = (s?.lastPrompt ? s.lastPrompt.slice(0, 60) : null) || s?.firstCommand;
  return s?.title || fallback || '(untitled)';
}

/**
 * @param {object} o
 * @param {{id:string, name:string}} o.recipe   the project whose sessions to list
 * @param {(s:object)=>void} [o.onPick]          a session was chosen (the picker is closed)
 * @param {()=>void} [o.onCancel]                closed with nothing chosen
 * @returns {{close:()=>void, el:HTMLElement}}   close() = cancel
 */
export function openResumePicker(o) {
  injectStyles();
  const r = o.recipe;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const scrim = document.createElement('div');
  scrim.className = 'rp-scrim';
  scrim.id = 'resumeModal';
  const box = document.createElement('div');
  box.className = 'rp-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'resumeTitle');
  const h = document.createElement('h2');
  h.id = 'resumeTitle';
  h.textContent = `Resume ${MDASH} ${r.name}`;
  const list = document.createElement('div');
  list.id = 'resumeList';
  list.className = 'rp-list';
  list.innerHTML = `<div class="dim">loading sessions${ELL}</div>`;
  const acts = document.createElement('div');
  acts.className = 'rp-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.id = 'resumeCancelBtn';
  cancel.className = 'rp-cancel';
  cancel.textContent = 'Cancel';
  acts.append(cancel);
  box.append(h, list, acts);
  scrim.append(box);
  document.body.append(scrim);

  let done = false;
  function finish(picked) {
    if (done) { return; }
    done = true;
    window.removeEventListener('keydown', onKey, true);
    scrim.remove();
    if (opener?.isConnected) { opener.focus({ preventScroll: true }); }
    try {
      if (picked) { o.onPick?.(picked); } else { o.onCancel?.(); }
    } catch (e) {
      console.error('resume picker callback', e); // a caller's throw must not vanish in a click handler
    }
  }
  function onKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    } else if (ev.key === 'Tab') {
      /* ALWAYS ours while open: a host's own trap (the + sheet keeps Tab
         inside itself) would otherwise pull focus out from under the picker. */
      ev.stopPropagation();
      const f = [...box.querySelectorAll('button')].filter((x) => !x.disabled);
      if (!f.length) { return; }
      const i = f.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) {
        ev.preventDefault();
        f[f.length - 1].focus();
      } else if (!ev.shiftKey && (i === f.length - 1 || i < 0)) {
        ev.preventDefault();
        f[0].focus();
      }
    }
  }
  window.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', () => finish(null));
  scrim.addEventListener('click', (ev) => {
    if (ev.target === scrim) { finish(null); }
  });
  focusInto(cancel);

  fetch(`/api/recipes/${encodeURIComponent(r.id)}/sessions`)
    .then((res) => res.json())
    .then(({ sessions }) => {
      if (done) { return; }
      if (!sessions || sessions.length === 0) {
        list.innerHTML = '<div class="dim">No resumable sessions found for this project folder.</div>';
        return;
      }
      list.innerHTML = '';
      for (const s of sessions) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'resume-row';
        row.dataset.session = s.sessionId;
        row.innerHTML = '<span class="rr-title"></span><span class="rr-prompt dim"></span><span class="rr-meta dim"></span>';
        row.querySelector('.rr-title').textContent = sessionLabel(s);
        row.querySelector('.rr-prompt').textContent = s.title && s.lastPrompt
          ? s.lastPrompt.slice(0, 90) + (s.lastPrompt.length > 90 ? ELL : '')
          : '';
        row.querySelector('.rr-meta').textContent = [
          ago(s.mtimeMs),
          s.branch,
          s.sizeBytes ? fmtSize(s.sizeBytes) : null,
          s.sessionId.slice(0, 8) + ELL,
        ].filter(Boolean).join(` ${MIDDOT} `);
        row.title = s.sessionId; // full uuid on hover, for comparing elsewhere
        row.addEventListener('click', () => finish(s));
        list.appendChild(row);
      }
      if (document.activeElement === cancel) {
        focusInto(list.querySelector('.resume-row'));
      }
    })
    .catch((err) => {
      if (!done) {
        list.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'dim';
        d.textContent = `failed to list sessions: ${err?.message ?? err}`;
        list.append(d);
      }
    });

  return { close: () => finish(null), el: scrim };
}
