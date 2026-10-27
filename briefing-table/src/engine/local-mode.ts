/* LOCAL MODE [master spec Part A3, lead ruling 15583]: the room engine as a child process of the desktop app, for one person on one
 * PC. Pure and import-free, so auth.ts and server/index.ts can both ask it without a cycle.
 *
 * What it changes, and nothing else:
 *   - needs the per-launch token from the supervisor in HARBOR_WB_TOKEN, and refuses to run without one. The token is NEVER
 *     minted or written to disk here (the server mode writes secrets/engine.token; a file under a user's profile is a credential
 *     left lying around);
 *   - needs HARBOR_WB_DATA_DIR, so no state lands in the install folder;
 *   - listens on 127.0.0.1 only; the port defaults to 0 (the OS picks) and the real port is announced on one stdout line;
 *   - answers only requests whose Host header is the loopback name and the real port (a web page cannot reach it through DNS
 *     rebinding), and only upgrades whose Origin, if any, is the same;
 *   - no accounts: identity must be 'legacy' (the shared-token path), because there is nobody to sign in.
 * Everything else (rooms, floor, notes, the / commands) is the same engine code as the server. */

import { resolve, sep } from 'node:path';

/** Whether two folders are the same or one holds the other (case-insensitive on Windows, where the file system is). */
export function foldersOverlap(a: string, b: string, win = process.platform === 'win32'): boolean {
  const n = (p: string): string => {
    const r = resolve(p);
    return win ? r.toLowerCase() : r;
  };
  const x = n(a);
  const y = n(b);
  return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep) || y.startsWith(x.endsWith(sep) ? x : x + sep);
}

export interface LocalModeConfig {
  enabled: boolean;
  /** Reasons the engine must not start in local mode; empty when it may. */
  problems: string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function localModeConfig(env: Record<string, string | undefined>): LocalModeConfig {
  if ((env.HARBOR_WB_MODE ?? '').trim().toLowerCase() !== 'local') {
    return { enabled: false, problems: [] };
  }
  const problems: string[] = [];
  if (!env.HARBOR_WB_TOKEN?.trim()) {
    problems.push('HARBOR_WB_TOKEN is not set (the supervisor passes a per-launch token; local mode never mints one)');
  }
  if (!env.HARBOR_WB_DATA_DIR?.trim()) {
    problems.push('HARBOR_WB_DATA_DIR is not set (local mode keeps its data in the app data folder, never in the install folder)');
  }
  if (!env.HARBOR_WB_FILES_DIR?.trim()) {
    problems.push('HARBOR_WB_FILES_DIR is not set (the person\'s files folder, chosen at first run: assets and notes live there)');
  }
  if (env.HARBOR_WB_FILES_DIR?.trim() && env.HARBOR_WB_DATA_DIR?.trim() && foldersOverlap(env.HARBOR_WB_FILES_DIR, env.HARBOR_WB_DATA_DIR)) {
    problems.push('HARBOR_WB_FILES_DIR and HARBOR_WB_DATA_DIR overlap (the files folder must be separate from the engine data folder: it is the part an uninstall never touches)');
  }
  const host = env.HARBOR_WB_HOST?.trim();
  if (host && host !== '127.0.0.1') {
    problems.push(`HARBOR_WB_HOST is ${host} (local mode listens on 127.0.0.1 only)`);
  }
  const identity = (env.HARBOR_WB_IDENTITY ?? 'legacy').trim().toLowerCase();
  if (identity !== 'legacy') {
    problems.push(`HARBOR_WB_IDENTITY is ${identity} (local mode has no accounts)`);
  }
  return { enabled: true, problems };
}

/** The port local mode listens on: the setting when it is a valid port number (0 = the OS picks), else 0. */
export function localPort(env: Record<string, string | undefined>): number {
  const raw = env.HARBOR_WB_PORT?.trim();
  if (raw === undefined || raw === '') {
    return 0;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

/** Is this Host header the loopback name on the engine's own port? A browser page on another site that was DNS-pointed at 127.0.0.1
 *  sends its own hostname here, so it is refused. */
export function hostHeaderAllowed(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }
  const i = host.lastIndexOf(':');
  const name = i > host.lastIndexOf(']') ? host.slice(0, i) : host;
  const p = i > host.lastIndexOf(']') ? Number(host.slice(i + 1)) : 80;
  return LOOPBACK_HOSTS.has(name.toLowerCase()) && p === port;
}

export function isLocalMode(env: Record<string, string | undefined>): boolean {
  return (env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local';
}

/** The engine must never register a scheduled task or start a broker on its own in local mode: the app supervises the broker, and a
 *  per-user logon task would outlive an uninstall. service mode keeps its default (on unless '0'). */
export function brokerAutostartEnabled(env: Record<string, string | undefined>): boolean {
  return !isLocalMode(env) && env.HARBOR_WB_BROKER_AUTOSTART !== '0';
}

/** Extra Origins the supervisor allows (the app's own windows, if they are not served from the engine): HARBOR_WB_ALLOWED_ORIGINS,
 *  comma separated, exact match. Anything else that is not our own loopback origin is refused. */
export function supervisorOrigins(env: Record<string, string | undefined>): string[] {
  return (env.HARBOR_WB_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

/** A request (HTTP or upgrade) that a BROWSER sent from somewhere it must not: it names a foreign Origin, or has no Origin but says
 *  Sec-Fetch-Site: cross-site. Real clients (the app's main process, curl, the hooks) send neither header. A web page in the user's own
 *  browser can reach 127.0.0.1:<port> (the port is scannable) and its Host header would pass the Host check, so this is the gate that
 *  keeps it from the routes that need no token (the hook sinks, /login) and from the sockets. */
export function browserOriginRefused(headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] }, port: number, extra: string[] = []): boolean {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (origin !== undefined) {
    return !(extra.includes(origin) || originAllowed(origin, port));
  }
  const site = Array.isArray(headers['sec-fetch-site']) ? headers['sec-fetch-site'][0] : headers['sec-fetch-site'];
  return site === 'cross-site';
}

/** A WebSocket Origin is allowed when it is absent (a non-browser client) or is the same loopback origin. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) {
    return true;
  }
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port;
  } catch {
    return false;
  }
}

/** The one line the supervisor waits for; bounded and carrying nothing secret. */
export function readyLine(port: number): string {
  return JSON.stringify({ ready: true, mode: 'local', port });
}
