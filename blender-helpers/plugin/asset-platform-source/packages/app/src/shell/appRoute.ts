// Full-page apps (task; Aurora fullpage-apps-v1.2 §3): an OVERLAY ROUTE over the library, which
// stays mounted underneath (inert), so search, filters, sections, tool, Preview and scroll are
// still there on return. URL-driven, so Back works and links share:
//   ?app=clip-editor            empty (the picker is offered, not auto-opened)
//   ?app=clip-editor&edit=<id>  loaded (&from=<childId> = "Edit again" on a clip it made)
//   ?edit=<id>                  the P1 link — normalised on load (replaceState)
// Enter = push {app, edit, fromLibrary, lib}; change clip = replace (Back leaves the app, it never
// steps through clips); ← = history.back() when fromLibrary, else replace to the library. Back, ←
// and the edge swipe all land in one popstate handler that renders from the URL.
import { useEffect, useState } from 'react';

export interface AppRoute { app: string | null; edit: string | null; from: string | null }
/** What the library looked like when an app opened — restored after a reload inside the app. */
export interface LibSnapshot { query?: unknown; viewerId?: string | null; toolId?: string | null; scroll?: number }

const APP_KEYS = ['app', 'edit', 'from'];
const EVENT = 'asset-app-route';
const SNAP = 'assetlib.libSnapshot';

export function readRoute(): AppRoute {
  const q = new URLSearchParams(location.search);
  return { app: q.get('app'), edit: q.get('edit'), from: q.get('from') };
}

function urlFor(r: Partial<AppRoute>): string {
  const q = new URLSearchParams(location.search);
  for (const k of APP_KEYS) q.delete(k);
  if (r.app) q.set('app', r.app);
  if (r.edit) q.set('edit', r.edit);
  if (r.from) q.set('from', r.from);
  const s = q.toString();
  return location.pathname + (s ? `?${s}` : '') + location.hash;
}

/** Old ?edit=<id> links keep working: rewrite them to ?app=clip-editor&edit=<id> in place. */
export function normaliseLegacyRoute() {
  const q = new URLSearchParams(location.search);
  if (q.get('edit') && !q.get('app')) history.replaceState(history.state, '', urlFor({ app: 'clip-editor', edit: q.get('edit'), from: q.get('from') }));
}

/** A real href for middle-click / copy-link; a normal click goes through openApp. */
export const appHref = (app: string, edit?: string | null, from?: string | null) => urlFor({ app, edit, from });

const announce = () => window.dispatchEvent(new Event(EVENT));
let opener: HTMLElement | null = null;
let fallbackOpener: string | null = null;
let draftSaved = false;
/** The editor autosaved a draft in this visit — only then does leaving say "Draft kept". */
export const noteDraftSaved = () => { draftSaved = true; };
export const takeDraftSaved = () => { const d = draftSaved; draftSaved = false; return d; };

/** `fallback`: a selector to focus on return when the opener itself is gone (e.g. the ☰ menu item). */
export function openApp(app: string, edit: string | null, from: string | null, lib: LibSnapshot, fallback: string | null = null) {
  opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  fallbackOpener = fallback;
  draftSaved = false;
  try { sessionStorage.setItem(SNAP, JSON.stringify(lib)); } catch { /* private mode */ }
  history.pushState({ app, edit, fromLibrary: true, lib }, '', urlFor({ app, edit, from }));
  announce();
}

/** Another source inside the open app: a replace, so Back still leaves the app. */
export function replaceApp(edit: string | null, from: string | null = null) {
  history.replaceState({ ...(history.state || {}), edit }, '', urlFor({ app: readRoute().app, edit, from }));
  announce();
}

export function leaveApp() {
  if (history.state?.fromLibrary) { history.back(); return; }
  history.replaceState(null, '', urlFor({}));   // a cold deep link: land on the default library
  announce();
}

/** The snapshot to restore after a reload inside an app (history.state first, then sessionStorage). */
export function savedSnapshot(): LibSnapshot | null {
  if (history.state?.lib) return history.state.lib;
  try { return JSON.parse(sessionStorage.getItem(SNAP) || 'null'); } catch { return null; }
}

/** Focus goes back to whatever opened the app (☰, the card, Preview's ✂) — if it's still there. */
export function refocusOpener() {
  const el = opener?.isConnected ? opener : fallbackOpener ? document.querySelector<HTMLElement>(fallbackOpener) : null;
  el?.focus();
  opener = null; fallbackOpener = null;
}

export function useAppRoute(): AppRoute {
  const [r, setR] = useState(readRoute);
  useEffect(() => {
    const on = () => setR(readRoute());
    window.addEventListener('popstate', on);
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener(EVENT, on); };
  }, []);
  return r;
}

// Picker "Recents": the last 10 opened/edited on THIS device (localStorage, Aurora §F default).
export interface RecentAsset { id: string; label?: string | null; filename?: string | null; category: string; duration_s?: number | null }
const RECENTS = 'assetlib.recents.v1';
export function readRecents(): RecentAsset[] {
  try { return JSON.parse(localStorage.getItem(RECENTS) || '[]'); } catch { return []; }
}
export function pushRecent(a: RecentAsset) {
  const keep = { id: a.id, label: a.label, filename: a.filename, category: a.category, duration_s: a.duration_s };
  try { localStorage.setItem(RECENTS, JSON.stringify([keep, ...readRecents().filter(x => x.id !== a.id)].slice(0, 10))); } catch { /* private mode */ }
}
