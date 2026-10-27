// Browser substitutes only. This module owns no engine routes or credentials.
export class BrowserActionError extends Error {
  constructor(code) { super(code); this.name = 'BrowserActionError'; this.code = code; }
}
const MAX_CLIPBOARD = 100000;
export function createBrowserActions(browser = window) {
  let alive = true;
  const notifications = new Set();
  const fail = code => { throw new BrowserActionError(code); };
  function current() { if (!alive) fail('disposed'); }
  function secure() { current(); if (browser.isSecureContext !== true) fail('secure-context-required'); }
  function gesture() { current(); if (browser.navigator?.userActivation?.isActive !== true) fail('user-gesture-required'); }
  function clipboard(method) {
    secure(); gesture();
    if (typeof browser.navigator?.clipboard?.[method] !== 'function') fail('clipboard-unavailable');
    return browser.navigator.clipboard;
  }
  function webUrl(value, internal) {
    current();
    if (typeof value !== 'string' || value.length > 4096) fail('unsafe-url');
    let url, origin;
    try { url = new URL(value, browser.location.href); origin = new URL(browser.location.href).origin; }
    catch { fail('unsafe-url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (internal && url.origin !== origin)) fail('unsafe-url');
    return url.href;
  }
  function open(value, internal) {
    const url = webUrl(value, internal); gesture();
    // Open a blank, same-origin context so blocked popups are observable. Clear
    // opener and referrer BEFORE any destination can run, then navigate once.
    if (typeof browser.open !== 'function') fail('popup-unavailable');
    const child = browser.open('about:blank', '_blank');
    if (!child) fail('popup-blocked');
    try {
      child.opener = null;
      if (child.opener !== null) throw new Error();
      const referrer = child.document.createElement('meta');
      referrer.name = 'referrer'; referrer.content = 'no-referrer';
      child.document.head.append(referrer);
      child.location.replace(url);
      return true;
    } catch {
      try { child.close(); } catch { /* ownership is already fenced */ }
      fail('popup-unavailable');
    }
  }
  function notificationStatus() {
    current();
    if (browser.isSecureContext !== true || typeof browser.Notification !== 'function') return 'unavailable';
    const status = browser.Notification.permission;
    return ['default', 'granted', 'denied'].includes(status) ? status : 'unavailable';
  }
  return Object.freeze({
    async copyText(text) {
      const clip = clipboard('writeText');
      if (typeof text !== 'string') fail('clipboard-invalid');
      if (text.length > MAX_CLIPBOARD) fail('clipboard-too-large');
      try { await clip.writeText(text); } catch { fail('clipboard-denied'); }
      current(); return true;
    },
    async readText() {
      const clip = clipboard('readText'); let text;
      try { text = await clip.readText(); } catch { fail('clipboard-denied'); }
      current();
      if (typeof text !== 'string') fail('clipboard-invalid');
      if (text.length > MAX_CLIPBOARD) fail('clipboard-too-large');
      return text;
    },
    openTab: url => open(url, true),
    openExternal: url => open(url, false),
    notificationStatus,
    async requestNotifications() {
      secure();
      const status = notificationStatus();
      if (status === 'unavailable') fail('notifications-unavailable');
      if (status !== 'default') return status;
      gesture(); let next;
      try { next = await browser.Notification.requestPermission(); } catch { fail('notification-denied'); }
      current();
      return ['default', 'granted', 'denied'].includes(next) ? next : 'unavailable';
    },
    notify(title, { body = '', tag = '', onClick, silent = true } = {}) {
      secure();
      if (notificationStatus() !== 'granted') fail('notification-permission');
      if (typeof title !== 'string' || !title || title.length > 200 || typeof body !== 'string' || body.length > 500 || typeof tag !== 'string' || tag.length > 80) fail('notification-invalid');
      let note;
      try { note = new browser.Notification(title, { body, tag, silent: silent !== false }); }
      catch { fail('notifications-unavailable'); }
      notifications.add(note);
      note.onclick = () => { if (alive && typeof onClick === 'function') onClick(); };
      note.onclose = () => notifications.delete(note);
      return true;
    },
    dispose() {
      if (!alive) return;
      alive = false;
      for (const note of notifications) { try { note.close(); } catch { /* best effort after fencing */ } }
      notifications.clear();
    },
  });
}
