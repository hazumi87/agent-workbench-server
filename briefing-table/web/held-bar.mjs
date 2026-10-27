/* THE SOLO WINDOW'S HELD LINE (the design notes §3.6, S1).
 *
 * Room lines (and fabric envelopes) held back from THIS pane's input box, said
 * where the person who can see that box is looking: "2 held · draft · 3m".
 * The engine pushes `pane.held {paneid, held|null}` on every change and puts
 * `held` in `pane.ready` (S0); this module only renders what it is handed.
 *
 * The act has ONE verb, "Deliver N", and its suffix states the claim being
 * made by the person pressing it:
 *   - draft   → "Deliver N · box is empty"
 *   - startup → "Deliver N · nothing showing". The engine answers 409
 *               {prompt, promptAt} when it saw a prompt that may still be up;
 *               the confirm names that prompt and its age, and confirming
 *               resends {override: <that kind>}.
 *   - no-claude / restarting / busy / … → no button (never releasable here).
 * POST /api/panes/:id/deliver-held takes the window's COOKIE only: this page's
 * fetch sends no Authorization header, so an agent can never press it.
 *
 * Kept out of solo.js on purpose (solo.* is vrpc1's to review): solo.js mounts
 * it and forwards two messages, nothing else.
 */

import { heldWord } from '/held-words.mjs';

const WHY = {
  draft: 'an unsent draft in its input box',
  busy: 'it is busy',
  startup: 'a question is up in this window',
  'waiting-for-tools': 'Codex is loading its room tools (up to 30 seconds)',
  'needs-you': 'this window shows a prompt only you can answer',
  'no-claude': "claude isn't running in it",
  restarting: 'it is restarting onto the channel',
  'not-idle': 'it is not idle',
  settling: 'it is settling',
  'awaiting-idle': 'waiting for the previous line to land',
  'not-live': 'it is not live',
  pending: 'waiting its turn',
};

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) { return `${s}s`; }
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/**
 * @param {HTMLElement} el   the bar (starts hidden)
 * @param {string} paneid
 * @param {{onDone?: () => void, canDeliver?: () => boolean, onTakeControl?: () => void}} [opts]
 *   canDeliver: CONTROLLER-ONLY (nuc1 ruling 2026-09-26): the harm is a line
 *   landing on text someone is typing right now, and only the controller can
 *   be typing; a viewer sees the line and "Take control to deliver", which
 *   opens the existing control prompt (onTakeControl).
 *   onDone: hand focus back (the terminal).
 *   Every control on the solo page keeps or returns the terminal's focus; a
 *   click here must too, or the next keystroke goes nowhere and a phone drops
 *   its keyboard (vrpc1 review, CHANGE 1).
 * @returns {{set: (held: object|null) => void}}
 */
export function mountHeldBar(el, paneid, opts = {}) {
  let held = null;
  let confirmFor = null; // {prompt, promptAt} while the override confirm is up
  let note = '';
  let noteTimer = 0;
  let busy = false;
  const done = () => { try { opts.onDone?.(); } catch { /* host's problem */ } };
  /* A note is transient: it clears after 5 s so the bar never lingers on a
     note alone (every show/hide refits the terminal; CHANGE 2). */
  function setNote(n) {
    note = n;
    clearTimeout(noteTimer);
    if (n) {
      noteTimer = setTimeout(() => { note = ''; render(); }, 5000);
    }
  }

  async function deliver(override) {
    busy = true;
    render();
    let r;
    try {
      const res = await fetch(`/api/panes/${encodeURIComponent(paneid)}/deliver-held`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(override ? { override } : {}),
      });
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      r = { status: res.status, ok: res.ok, body };
    } catch (e) {
      r = { status: 0, ok: false, body: { error: e?.message ?? String(e) } };
    }
    busy = false;
    confirmFor = null;
    const b = r.body ?? {};
    if (r.ok) {
      setNote(b.result === 'injected' ? '' : b.result === 'empty' ? 'nothing was waiting' : `still held: ${String(b.result).replace(/^held:/, '')}`);
      if ('held' in b) { held = b.held; }
    } else if (r.status === 409 && b.reason === 'startup' && b.prompt) {
      confirmFor = { prompt: b.prompt, promptAt: b.promptAt };
      setNote('');
    } else if (r.status === 409 && b.reason === 'no-claude') {
      setNote("claude isn't running in it: start it here (fg, or type claude), or Restore");
    } else {
      setNote(`not delivered — ${b.error ?? `HTTP ${r.status}`}`);
    }
    render();
    if (!confirmFor) {
      done(); // back to the terminal (the confirm keeps focus for its own buttons)
    }
  }

  function render() {
    el.textContent = '';
    const h = held;
    if (!h || !(h.depth > 0)) {
      el.hidden = !note;
      if (note) {
        const n = document.createElement('span');
        n.className = 'held-note';
        n.textContent = note;
        el.append(n);
      }
      return;
    }
    el.hidden = false;
    el.dataset.reason = h.reason;
    const t = document.createElement('span');
    t.className = 'held-text';
    const since = typeof h.since === 'number' ? ` · ${ago(h.since)}` : '';
    const notInteractive = h.reason === 'no-claude' && h.detail === 'not-interactive';
    t.textContent = `${h.depth} held · ${heldWord(h)}${since}`;
    const why = notInteractive ? 'a claude is running here but not as its interactive session'
      : h.reason === 'startup' && h.prompt === 'unknown' ? 'the engine could not see this claude start'
        : h.reason === 'startup' && h.prompt ? `a ${h.prompt} question is up in this window` : WHY[h.reason] ?? h.reason;
    t.title = `${h.depth} room line${h.depth === 1 ? '' : 's'} held, not yet typed here: ${why}`;
    el.append(t);

    if (confirmFor) {
      const c = document.createElement('span');
      c.className = 'held-confirm';
      const age = typeof confirmFor.promptAt === 'number' ? `${ago(confirmFor.promptAt)} ago` : 'recently';
      /* "unknown" = the engine could not watch this claude's first screen */
      c.textContent = confirmFor.prompt === 'unknown'
        ? 'The engine could not see this claude start. Deliver only if its window shows the input box.'
        : `The engine saw a ${confirmFor.prompt} prompt ${age}. Deliver only if this window shows its input box.`;
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'held-btn';
      yes.textContent = `Deliver ${h.depth} anyway`;
      yes.disabled = busy;
      yes.addEventListener('click', () => void deliver(confirmFor.prompt));
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'held-btn held-cancel';
      no.textContent = 'Cancel';
      no.addEventListener('click', () => { confirmFor = null; render(); done(); });
      el.append(c, yes, no);
      return;
    }

    const label = h.reason === 'draft' ? `Deliver ${h.depth} · box is empty`
      : h.reason === 'startup' ? `Deliver ${h.depth} · nothing showing` : null;
    if (label && opts.canDeliver && !opts.canDeliver()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'held-btn';
      b.textContent = 'Take control to deliver';
      b.title = 'only the window that has control can say its input box is clear';
      b.addEventListener('click', () => opts.onTakeControl?.());
      el.append(b);
    } else if (label) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'held-btn';
      b.textContent = label;
      b.disabled = busy;
      b.title = h.reason === 'draft'
        ? 'only if the input box below is empty: this types the held lines now'
        : 'only if no question is showing in this window: this types the held lines now';
      b.addEventListener('click', () => void deliver(null));
      el.append(b);
    }
    if (note) {
      const n = document.createElement('span');
      n.className = 'held-note';
      n.textContent = note;
      el.append(n);
    }
  }

  return {
    /** control changed: redraw (Deliver vs "Take control to deliver") */
    refresh() {
      render();
    },
    set(next) {
      held = next && typeof next === 'object' ? next : null;
      if (!held || !(held.depth > 0)) {
        confirmFor = null;
        setNote(''); // nothing held: no note-only bar left behind (CHANGE 2)
      }
      render();
    },
  };
}
