/* ROOM APP PORT, the pieces the rail (room-cells.mjs) and the full page
 * (room-app.mjs) both use, so an app's port means the same thing in both
 * [ticket]: the action POST and its answer words, the copy and download
 * hands a sandboxed frame lacks, and how a full page opens in the shell.
 * DOM, no imports (the page that loads it passes what it needs).
 */

export const ACTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const ACTION_GAP_MS = 500;

/** One panel action, as the person: POST /api/rooms/:id/panels/:pid/action.
 *  -> {ok, error?, warning?, entries?}; error in the panel contract's words
 *  (a held app 'needs-approval', an unregistered one 'not-registered'). */
export async function runPanelAction(roomId, panelId, d) {
  let ok = false;
  let error = '';
  let warning = ''; // [ticket] the action ran, but its room line was not posted
  let entries = null;
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/panels/${encodeURIComponent(panelId)}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: d.name, params: d.params ?? {}, ...(d.input !== undefined ? { input: d.input } : {}) }),
    });
    ok = r.ok;
    if (ok) {
      try {
        const j = await r.json();
        warning = typeof j?.warning === 'string' ? j.warning : '';
        entries = Array.isArray(j?.entries) && j.entries.length ? j.entries : null;
      } catch { /* not json */ }
    } else {
      error = `HTTP ${r.status}`;
      try { error = (await r.json()).error ?? error; } catch { /* not json */ }
      if (r.status === 409 && error === 'held') {
        error = 'needs-approval';
      } else if (r.status === 409 && error === 'not-registered') {
        error = 'not-registered';
      }
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }
  return { ok, error, warning, entries };
}

/** Copy text; true when it landed (the clipboard, else a textarea). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Save a URL with the page's own <a download> (the caller resolved it). */
export function saveUrl(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.setAttribute('download', typeof name === 'string' ? name.slice(0, 200) : '');
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Open `url` as a tab of the CLI Manager shell that holds this page, SELECTED
 *  (the shell's {hwbOpenTab}); `key` is its sessionId, so asking for the same
 *  key again selects the tab that is already open. Outside a shell: a new
 *  browser tab. -> 'shell' | 'window' | 'blocked'. */
export function openTab(url, title, key) {
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ hwbOpenTab: { url, title, sessionId: key } }, '*');
      return 'shell';
    } catch { /* no shell after all */ }
  }
  /* not the 'noopener' feature: it makes window.open answer null always, so a
     blocked popup could not be told from an opened one */
  const w = window.open(url, '_blank');
  if (!w) {
    return 'blocked';
  }
  w.opener = null;
  return 'window';
}
