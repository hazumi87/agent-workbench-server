// A module page's delete, confirmed in the app's own dialog (Tasks seam S4 step 5; the design, Client ).
// spec from module-requests.js deleteDialog(): the quoted task title on its own line, clamped to two lines,
// then the lines in order. Every text is set with textContent. Cancel is the default focus (o.focus) and neutral, Delete
// the error role; Esc and the scrim (the dialog closing without a choice) answer no, and so does an abort of
// signal (the page's link ended). No imports.

export function confirmDelete(openDialog, host, spec, doc = globalThis.document, signal = null) {
  return new Promise((resolve) => {
    let done = false;
    const answer = (yes) => { if (!done) { done = true; resolve(yes); } };
    const body = doc.createElement('div');
    if (spec && spec.quoted) {
      const q = doc.createElement('div');
      q.className = 'wr-dlgx';
      q.textContent = spec.quoted;
      // two lines at most, with an ellipsis, so a long title can never push the buttons off
      q.style.display = '-webkit-box';
      q.style.WebkitLineClamp = '2';
      q.style.WebkitBoxOrient = 'vertical';
      q.style.overflow = 'hidden';
      body.appendChild(q);
    }
    const lines = (spec && spec.lines) || [];
    lines.forEach((line, i) => {
      const p = doc.createElement('div');
      p.className = 'wr-dlgx';
      p.textContent = line;
      // the design, Fix D: 8 px above the sentence after the quoted title, 8 px above the last line, which never wraps
      if ((i === 0 && spec.quoted) || (i === lines.length - 1 && lines.length > 1)) p.style.marginTop = '8px';
      if (i === lines.length - 1) p.style.whiteSpace = 'nowrap';
      body.appendChild(p);
    });
    const dlg = openDialog(host, {
      title: (spec && spec.title) || 'Delete this task?',
      body,
      // openDialog focuses the action named here (else the LAST button, Delete); no primary: there is no text
      // field, and Enter must never mean Delete
      focus: 'Cancel',
      actions: [
        { label: 'Cancel', kind: 'text', fn: () => answer(false) },
        { label: 'Delete', kind: 'error', fn: () => answer(true) },
      ],
      onClose: () => answer(false),
    });
    if (!dlg) {
      answer(false);
      return;
    }
    // the link was revoked or the room changed: close the dialog, the answer is no
    if (signal) {
      if (signal.aborted) dlg.close();
      else signal.addEventListener('abort', () => dlg.close(), { once: true });
    }
  });
}
