/* WHICH EDITION THIS INSTANCE IS [basic] (Owner 2026-10-08, room interface). /health says: 'full' (the Advanced Workbench, today's default) or
 * 'basic'. A missing or failed answer is FULL: a probe that cannot tell must never take features away. The answer is cached for the page and
 * written to <html data-edition> so a stylesheet can hide what Basic does not have (web/edition.css). Callers that branch in code use
 * isBasic() after `await loadEdition()`. */
let pending = null;
let value = 'full';

export function parseEdition(h) {
  return h && typeof h === 'object' && h.edition === 'basic' ? 'basic' : 'full';
}

export function loadEdition() {
  if (!pending) {
    pending = fetch('/health')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((h) => {
        value = parseEdition(h);
        document.documentElement.dataset.edition = value;
        return value;
      });
  }
  return pending;
}

export const isBasic = () => value === 'basic';
