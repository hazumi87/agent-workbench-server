/* ============================================================================
 * ROOM PANEL URLS — the allow-list (the design notes §2.6) [ticket].
 *
 * A room panel is an APP-SERVED web view the room page draws in an iframe
 * inside a cell of the room's left column. Registering one puts a URL in
 * front of Owner in his own window, so what may be registered is narrow:
 *
 *   - http: or https: ONLY. javascript:, data:, blob:, file:, about: … are
 *     refused — each can run script in, or read from, the page that frames it.
 *   - no credentials in the URL (user:pass@host): they would be shown to every
 *     viewer of the room and logged by the app.
 *   - the HOST must be on the list:
 *       loopback (localhost, 127.0.0.0/8, [::1]) — any port. NB: loopback is
 *         the VIEWER's machine, so a loopback panel only works on the host the
 *         app runs on; that is the honest meaning, not a bug;
 *       the server's tailnet name (server.example.ts.net) — any port;
 *       the VRPC agent-share, 100.64.0.1:8215 — that port only;
 *       config.json `panelHosts` (array) and env HARBOR_WB_PANEL_HOSTS (comma
 *         list): each entry is `host` (any port) or `host:port`. Read on every
 *         check (registration is rare), so an edit needs no restart.
 *
 * WHAT THE ROOM PAGE (cli-manager) MUST DO when it draws a panel:
 *   - iframe the panel's `frameUrl` (the ENGINE PROXY, server/panel-proxy.ts;
 *     it carries a per-panel token, so take it from the LATEST projection and
 *     change the iframe src only when frameUrl changes — it is stable for hours),
 *     NEVER its `url`: `url` resolves on the viewer's machine (a server loopback
 *     app is not on the laptop) and an http:// url is mixed content over
 *     Serve https. The proxy fetches it from where the engine runs.
 *   - <iframe src=frameUrl sandbox="allow-forms allow-popups
 *     allow-popups-to-escape-sandbox[ allow-scripts when panel.scripts]"
 *     referrerpolicy="no-referrer" loading="lazy">
 *   - NEVER `allow-same-origin`: the frame is served by the engine, so it IS
 *     the room page's origin, and a same-origin frame with scripts can lift its
 *     own sandbox and act as the room page with Owner's cookie. (The proxy also
 *     sends the same sandbox as a CSP header, so this holds even if the frame
 *     URL is opened top-level.) Consequence for app authors: no cookies or
 *     storage inside the panel.
 *   - never `allow-top-navigation` (a panel must not navigate Owner's window
 *     away) and never `allow-modals` by default.
 *   - render `title` and `icon` as TEXT / an icon KEY, never as HTML or a URL.
 * App authors: the proxy rewrites nothing in the body, so every link, script,
 * stylesheet and fetch in a panel app must be RELATIVE to the registered url.
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { instancePath } from './data-dir.ts';

/* Same file + test override as runtime-flags.ts. */
const configPath = (): string => process.env.HARBOR_WB_CONFIG || instancePath('config.json');

export const PANEL_URL_MAX = 2048;

/** Built-in entries: `host` = any port, `host:port` = that port only. */
export const BUILTIN_PANEL_HOSTS: readonly string[] = Object.freeze([
]);

function configuredHosts(): string[] {
  const out: string[] = [];
  const env = process.env.HARBOR_WB_PANEL_HOSTS;
  if (env) {
    out.push(...env.split(','));
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (cfg && Array.isArray(cfg.panelHosts)) {
      out.push(...cfg.panelHosts.filter((h: unknown): h is string => typeof h === 'string'));
    }
  } catch {
    /* no file / unparseable: the built-ins only (a safe default) */
  }
  return out.map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** The URL's port as written, or the scheme default. */
function portOf(u: URL): string {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

export type PanelUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Is `raw` a URL a room panel may show? Returns the normalised href. */
export function checkPanelUrl(raw: unknown): PanelUrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'url is an http(s) URL' };
  }
  const s = raw.trim();
  if (s.length > PANEL_URL_MAX) {
    return { ok: false, error: `url is over ${PANEL_URL_MAX} characters` };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'url is not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `url scheme ${u.protocol} is not allowed (http or https only)` };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'url must not carry credentials' };
  }
  const host = u.hostname.toLowerCase();
  if (isLoopback(host)) {
    return { ok: true, url: u.href };
  }
  const hostPort = `${host}:${portOf(u)}`;
  for (const entry of [...BUILTIN_PANEL_HOSTS, ...configuredHosts()]) {
    if (entry === host || entry === hostPort) {
      return { ok: true, url: u.href };
    }
  }
  return { ok: false, error: `url host ${u.host} is not on the panel allow-list (config.json panelHosts)` };
}
