// The app's own confirmation, in place of the browser's confirm(): a modal <dialog> with a heading, one plain line and two buttons
// (the safe one first), a bottom sheet under 600 px. confirmDialog(message, {document}) -> Promise<boolean>; Esc and the backdrop keep things as they are.
const LABELS = [
  [/^Delete\b/, ['Keep it', 'Delete']],
  [/^Discard\b/, ['Keep editing', 'Discard']],
  [/^Replace\b/, ['Keep my draft', 'Replace']],
];
export function confirmDialog(message, { document: doc = globalThis.document } = {}) {
  const text = String(message || '');
  const [keepWords, yesWords] = (LABELS.find(([re]) => re.test(text)) || [null, ['Cancel', 'OK']])[1];
  const cut = text.search(/[?.!](\s|$)/);
  const heading = cut < 0 ? text : text.slice(0, cut + 1), rest = cut < 0 ? '' : text.slice(cut + 1).trim();
  return new Promise((resolve) => {
    const dialog = doc.createElement('dialog'); dialog.className = 'web-confirm'; dialog.dataset.wbTest = 'web-confirm';
    const title = doc.createElement('h2'); title.id = 'web-confirm-title'; title.textContent = heading; dialog.setAttribute('aria-labelledby', title.id);
    const actions = doc.createElement('div'); actions.className = 'web-confirm-actions';
    const keep = doc.createElement('button'); keep.type = 'button'; keep.textContent = keepWords; keep.dataset.wbTest = 'web-confirm-keep';
    const yes = doc.createElement('button'); yes.type = 'button'; yes.textContent = yesWords; yes.className = 'web-confirm-yes'; yes.dataset.wbTest = 'web-confirm-yes';
    actions.append(keep, yes);
    dialog.append(title); if (rest) { const p = doc.createElement('p'); p.textContent = rest; dialog.append(p); } dialog.append(actions);
    let done = false;
    const settle = (v) => { if (done) return; done = true; if (dialog.open) dialog.close(); dialog.remove(); resolve(v); };
    keep.addEventListener('click', () => settle(false)); yes.addEventListener('click', () => settle(true));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); settle(false); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) settle(false); });
    (doc.body || doc.documentElement).append(dialog); dialog.showModal(); keep.focus();
  });
}
