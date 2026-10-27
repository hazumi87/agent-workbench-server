/* ===========================================================================
   hwb-copy.js — COPY FIELDS behavior                          v20 ·
   Companion: hwb-copy.css. No dependencies.

   The one rule that makes this file worth existing rather than being retyped
   per consumer:

       COPY READS THE DOM, NOT THE MASK.

   cfCopy() takes textContent off .cf-value, which is the real value whether or
   not the row is masked, because the masking is CSS. There is deliberately no
   `displayValue` and no masked string anywhere in this file — if there were,
   there would be a path where the clipboard receives dots, and a credential
   that silently copies as "••••••••" is worse than one that will not copy.
   =========================================================================== */

export const CF_KINDS = ['text', 'url', 'secret'];

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------------------
   cfRender(root, fields, opts) — paint the panel.

   fields[]: { label, value, kind?: 'text'|'url'|'secret' }
   Secrets render masked; the caller does not get to pre-mask them, and should
   not — see the rule above.
   --------------------------------------------------------------------------- */
export function cfRender(root, fields = [], { title = 'Handed to you', onCopy, onOpen } = {}) {
  if (!root) return root;
  const rows = fields.map((f, i) => {
    const kind = CF_KINDS.includes(f.kind) ? f.kind : 'text';
    /* Open only for a url, Show/Hide only for a secret, Copy always. The action
       set is derived from the kind rather than passed in, so two tools cannot
       offer different verbs for the same kind of value. */
    /* `.cf-act` ALONE — do not add `btn sm ghost` here.
       CLASS COLLISION, found by rendering: window-chrome already owns `.ghost`
       (the absolutely-positioned watermark behind the terminal, width 46% /
       max 330px). The design system's button modifier is ALSO called `.ghost`. They never
       met in the styleguide; inside this bundle they do, and the Copy button
       was laid out 130px above its own row, 330px wide, outside the panel.
       Every computed-style assertion passed while it happened — border, radius,
       padding and font were all correct, on an element in the wrong place.
       .cf-act is self-contained (see hwb-copy.css) precisely so this markup
       needs no shared button class. */
    const acts = [
      kind === 'url'    ? `<button class="cf-act" data-act="open"   data-i="${i}">Open</button>` : '',
      kind === 'secret' ? `<button class="cf-act" data-act="reveal" data-i="${i}">Show</button>` : '',
      `<button class="cf-act" data-act="copy" data-i="${i}">Copy</button>`,
    ].join('');
    return `<div class="cf-row${kind === 'secret' ? ' is-masked' : ''}" data-kind="${kind}" data-i="${i}">
      <div class="cf-head">
        <span class="cf-label" title="${esc(f.label)}">${esc(f.label)}</span>
        ${kind !== 'text' ? `<span class="cf-kind">${kind}</span>` : ''}
        <span class="cf-acts">${acts}</span>
      </div>
      <div class="cf-value">${esc(f.value)}</div>
    </div>`;
  }).join('');

  root.className = 'copyfields-panel';
  root.innerHTML = `
    <div class="copyfields-head">
      <span class="copyfields-title">${esc(title)}</span>
      <span class="copyfields-count">${fields.length}</span>
    </div>
    ${fields.length ? `<div class="copyfields">${rows}</div>`
                    : `<div class="copyfields-empty">Nothing waiting.</div>`}`;

  root.querySelectorAll('.cf-act').forEach(b => b.addEventListener('click', () => {
    const row = b.closest('.cf-row');
    if (b.dataset.act === 'copy')   { cfCopy(row).then(ok => ok && cfFlash(b, 'Copied')); onCopy?.(row); }
    if (b.dataset.act === 'reveal') { b.textContent = cfToggleMask(row) ? 'Show' : 'Hide'; }
    if (b.dataset.act === 'open')   { onOpen?.(cfValue(row), row); }
  }));
  return root;
}

/** The value, masked or not. One accessor, so there is one answer. */
export function cfValue(row) {
  return row?.querySelector('.cf-value')?.textContent ?? '';
}

/** Copy. Falls back to a selection-based copy where the async clipboard is
 *  unavailable or permission-blocked — a WebView2 without clipboard-write
 *  should not be a panel whose only button does nothing. */
export async function cfCopy(row) {
  const v = cfValue(row);
  if (!v) return false;
  try {
    await navigator.clipboard.writeText(v);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = v;                              // the REAL value; masking is CSS and does not reach here
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/** Toggle presentation only. Returns the NEW masked state. */
export function cfToggleMask(row) {
  return !!row?.classList.toggle('is-masked');
}

/** Say it happened, then stop saying it. */
export function cfFlash(btn, word = 'Copied', ms = 1400) {
  if (!btn) return;
  const was = btn.dataset.was ?? btn.textContent;
  btn.dataset.was = was;
  btn.textContent = word;
  btn.classList.add('is-done');
  clearTimeout(btn._cfT);
  btn._cfT = setTimeout(() => { btn.textContent = was; btn.classList.remove('is-done'); }, ms);
}
