/* ============================================================================
 * THE CONCIERGE, engine half (the design notes, P0 + P1).
 *
 * A designated agent session that is Owner's guide across the Workbench. P0/P1
 * give it eyes, not hands: a SETTINGS row, a READ scope for exactly one pane,
 * a fly-out chat (the existing agent chat), wb: links, an unread count. No
 * proxy action exists yet (P2/P3).
 *
 *   SETTINGS   engine_settings key `concierge` (system-wide, like agentComms):
 *              {enabled, primary, fallback, active, allowed:{...}} — a strict
 *              PATCH validator and a lenient reader. Every allowed action is
 *              OFF by default and nothing acts on them before P3.
 *   THE PANE   the ACTIVE recipe's PRIMARY pane, `recipe:<id>` — deterministic,
 *              so a fresh `recipe:<id>#hex` pane of the same recipe is never the
 *              concierge (spec: "a different pane, even of the same recipe,
 *              never does"). Off switch = no concierge pane = the scope is gone
 *              on the very next request.
 *   SCOPE      read-only, on the PANE-TOKEN door only (server/concierge.ts). The
 *              pane-token door is behind HARBOR_WB_PANE_TOKENS=1, OFF on the server
 *              today: then the scope is unreachable and the UI says so. There is
 *              NEVER a fallback to the shared bearer.
 *   BASIC      no Concierge (Owner 2026-10-11): routes 404, settings and icon hidden.
 * ========================================================================== */

import { table } from '../table/endpoint.ts';
import { isBasic } from './agent-commands.ts';

export const ACTIONS = ['message', 'summaries', 'compactReload', 'inject', 'startRestore', 'dispatch'] as const;
export type Action = (typeof ACTIONS)[number];

export interface ConciergeSettings {
  enabled: boolean;
  /** recipe ids; the pair shares account, scope and authority, only the vendor differs */
  primary: string | null;
  fallback: string | null;
  /** which of the pair the icon and fly-out talk to (manual toggle in P0/P1) */
  active: 'primary' | 'fallback';
  allowed: Record<Action, boolean>;
  /** What the person calls it ("Olivia"): shown in the UI and matched in speech-to-text. */
  displayName: string | null;
  /** The typed address, stored WITHOUT the "@" ("olivia"). Spoken displayName -> "@handle". */
  handle: string | null;
}

export const DEFAULTS: Readonly<ConciergeSettings> = Object.freeze({
  enabled: false,
  primary: null,
  fallback: null,
  active: 'primary' as const,
  displayName: null,
  handle: null,
  allowed: Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a, false])) as Record<Action, boolean>),
});

const KEY = 'concierge';

/** Words an @ name may never be: they already mean something in a room line. */
export const RESERVED_HANDLES: readonly string[] = ['user', 'room', 'all', 'owner', 'everyone', 'here'];
const HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const DISPLAY_NAME_MAX = 40;

/** One right answer, so normalised without asking: trim, drop a leading "@", lowercase. null = not set. */
export function normalHandle(v: string): string {
  return v.trim().replace(/^@+/, '').toLowerCase();
}
function cleanName(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class ConciergeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Lenient: whatever is stored, a whole settings object (bad fields fall back). */
export function settingsFrom(raw: unknown): ConciergeSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const id = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const al = r.allowed && typeof r.allowed === 'object' ? (r.allowed as Record<string, unknown>) : {};
  return {
    enabled: r.enabled === true,
    primary: id(r.primary),
    fallback: id(r.fallback),
    active: r.active === 'fallback' ? 'fallback' : 'primary',
    allowed: Object.fromEntries(ACTIONS.map((a) => [a, al[a] === true])) as Record<Action, boolean>,
    displayName: typeof r.displayName === 'string' && cleanName(r.displayName) && !CONTROL_RE.test(r.displayName) ? cleanName(r.displayName).slice(0, DISPLAY_NAME_MAX) : null,
    handle: typeof r.handle === 'string' && HANDLE_RE.test(normalHandle(r.handle)) ? normalHandle(r.handle) : null,
  };
}

/** Strict: unknown keys, wrong types and unknown recipes are refused (400 with a field). */
export function validPatch(b: unknown, recipeExists: (id: string) => boolean, handleTaken: (h: string) => boolean = () => false): Partial<ConciergeSettings> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new ConciergeError('body', 'the body is an object of settings');
  }
  const out: Partial<ConciergeSettings> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw new ConciergeError(k, 'enabled is true or false');
      out.enabled = v;
    } else if (k === 'primary' || k === 'fallback') {
      if (v !== null && (typeof v !== 'string' || !recipeExists(v))) throw new ConciergeError(k, `${k} is a recipe id or null`);
      out[k] = v as string | null;
    } else if (k === 'displayName') {
      if (v === null || (typeof v === 'string' && !cleanName(v))) {
        out.displayName = null;
      } else if (typeof v !== 'string' || CONTROL_RE.test(v) || cleanName(v).length > DISPLAY_NAME_MAX) {
        throw new ConciergeError(k, `displayName is plain text, up to ${DISPLAY_NAME_MAX} characters, or empty`);
      } else {
        out.displayName = cleanName(v);
      }
    } else if (k === 'handle') {
      if (v === null || (typeof v === 'string' && !normalHandle(v))) {
        out.handle = null;
      } else if (typeof v !== 'string' || !HANDLE_RE.test(normalHandle(v))) {
        throw new ConciergeError(k, 'the @ name is 2 to 32 characters: a letter first, then letters, digits, - or _');
      } else if (RESERVED_HANDLES.includes(normalHandle(v))) {
        throw new ConciergeError(k, `@${normalHandle(v)} already means something in a room (${RESERVED_HANDLES.join(', ')})`);
      } else if (handleTaken(normalHandle(v))) {
        throw new ConciergeError(k, `@${normalHandle(v)} is already a seat's name`);
      } else {
        out.handle = normalHandle(v);
      }
    } else if (k === 'active') {
      if (v !== 'primary' && v !== 'fallback') throw new ConciergeError(k, 'active is "primary" or "fallback"');
      out.active = v;
    } else if (k === 'allowed') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConciergeError(k, 'allowed is an object of switches');
      const a: Partial<Record<Action, boolean>> = {};
      for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
        if (!(ACTIONS as readonly string[]).includes(ak)) throw new ConciergeError(`allowed.${ak}`, `unknown action (${ACTIONS.join(', ')})`);
        if (typeof av !== 'boolean') throw new ConciergeError(`allowed.${ak}`, 'each action is true or false');
        a[ak as Action] = av;
      }
      out.allowed = a as Record<Action, boolean>;
    } else {
      throw new ConciergeError(k, 'not a Concierge setting');
    }
  }
  return out;
}

export function settings(): ConciergeSettings {
  return settingsFrom(table.getEngineSetting(KEY));
}

export function setSettings(patch: Partial<ConciergeSettings>): ConciergeSettings {
  const cur = settings();
  const next: ConciergeSettings = { ...cur, ...patch, allowed: { ...cur.allowed, ...(patch.allowed ?? {}) } };
  if (next.primary && next.fallback && next.primary === next.fallback) {
    throw new ConciergeError('fallback', 'the fallback is a different recipe from the primary');
  }
  if (next.active === 'fallback' && !next.fallback) {
    throw new ConciergeError('active', 'there is no fallback recipe to make active');
  }
  table.setEngineSetting(KEY, next);
  return next;
}

/** The recipe the icon talks to now, or null. */
export function activeRecipe(s: ConciergeSettings = settings()): string | null {
  return s.active === 'fallback' ? s.fallback : s.primary;
}

/** THE concierge pane: the active recipe's PRIMARY pane, only while enabled
 *  and never in Basic. A fresh pane of the same recipe never is. */
export function conciergePane(s: ConciergeSettings = settings()): string | null {
  const r = activeRecipe(s);
  return !isBasic() && s.enabled && r ? `recipe:${r}` : null;
}

export function isConciergePane(paneid: string): boolean {
  const p = conciergePane();
  return p !== null && p === paneid;
}

/* ---------------------------------------------- unread: the seen cursor ---- */
/* Badge on the icon when the concierge has replied and the person has not
   looked (spec P1). A per-person cursor, {ts} of the newest agent reply they
   have seen; the count is the concierge's agent replies after it. Not a
   pseudo-room: it rides /api/rooms/me/unread as its own field. */

const seenKey = (userKey: string): string => `concierge.seen:${userKey}`;

export function seenOf(userKey: string): number {
  const v = table.getEngineSetting(seenKey(userKey)) as { ts?: unknown } | null;
  return v && typeof v.ts === 'number' ? v.ts : 0;
}

export function markSeen(userKey: string, ts: number): void {
  if (Number.isFinite(ts) && ts > seenOf(userKey)) {
    table.setEngineSetting(seenKey(userKey), { ts });
  }
}

export interface ChatTail {
  items: Array<{ id: string; role: string; ts: number }>;
}
let chatSource: ((paneid: string) => Promise<ChatTail | null>) | null = null;
/** index.ts hands in the agent chat's reader (it owns the chat deps). */
export function setChatSource(fn: (paneid: string) => Promise<ChatTail | null>): void {
  chatSource = fn;
}

const TAIL_CACHE_MS = 5_000;
let tailCache: { paneid: string; at: number; tail: ChatTail | null } | null = null;

/** `{unread, newestId}` for the person, or null when there is no concierge. */
export async function unreadFor(userKey: string, now = Date.now()): Promise<{ unread: number; newestId: string | null } | null> {
  const pane = conciergePane();
  if (!pane || !chatSource) {
    return null;
  }
  if (!tailCache || tailCache.paneid !== pane || now - tailCache.at > TAIL_CACHE_MS) {
    let tail: ChatTail | null = null;
    try {
      tail = await chatSource(pane);
    } catch {
      tail = null; // could not tell: no badge rather than a wrong one
    }
    tailCache = { paneid: pane, at: now, tail };
  }
  const agent = (tailCache.tail?.items ?? []).filter((i) => i.role === 'agent');
  const seen = seenOf(userKey);
  return { unread: agent.filter((i) => i.ts > seen).length, newestId: agent.length ? agent[agent.length - 1].id : null };
}

export function resetCache(): void {
  tailCache = null;
}

/* ------------------------------------------------------------ wb: links ---- */
/* The link schema the concierge writes in chat (spec P1):
     wb:room/<id>   wb:room/<id>#line-<n>   wb:pane/<paneid>   wb:app/<room>/<slug>   wb:manager
   Its replies are READ from its transcript, never POSTed through the engine, so
   they are validated when the chat page is SERVED: each link resolves to a URL
   or is dead with a note, and the page draws a chip only for a live one. */

export interface WbLink {
  href: string;
  ok: boolean;
  url?: string;
  label?: string;
  /** a room id when the link opens a room (the shell focuses an open tab by it) */
  room?: string;
  note?: string;
}

const WB_RE = /wb:(?:manager|room\/[A-Za-z0-9_-]+(?:#line-\d+)?|pane\/[A-Za-z0-9:_#.%-]+|app\/[A-Za-z0-9_-]+\/[a-z0-9-]+)/g;

/** Every wb: link in a text, in order, once each. */
export function linksIn(text: string): string[] {
  return [...new Set((text.match(WB_RE) ?? []).map((h) => h.replace(/[.,;:)]+$/, '')))];
}

export interface LinkDeps {
  room(id: string): { id: string; name: string; state: string } | undefined;
  lineInRoom(roomId: string, line: number): boolean;
  pane(paneid: string): { recipe_id: string | null; state: string } | undefined;
  soloPath(recipeId: string, paneid: string): string;
  roomHasApp(roomId: string, slug: string): boolean;
}

export function resolveLink(href: string, d: LinkDeps): WbLink {
  const roomUrl = (id: string): string => `/room.html?room=${encodeURIComponent(id)}`;
  if (href === 'wb:manager') {
    return { href, ok: true, url: '/manager.html', label: 'Workbench' };
  }
  let m = /^wb:room\/([A-Za-z0-9_-]+)(?:#line-(\d+))?$/.exec(href);
  if (m) {
    const r = d.room(m[1]);
    if (!r || r.state !== 'open') {
      return { href, ok: false, note: 'that room is not open' };
    }
    if (m[2] && !d.lineInRoom(r.id, Number(m[2]))) {
      return { href, ok: false, note: `line #${m[2]} is not in ${r.name}` };
    }
    return { href, ok: true, url: roomUrl(r.id) + (m[2] ? `#line-${m[2]}` : ''), label: m[2] ? `${r.name} #${m[2]}` : r.name, room: r.id };
  }
  m = /^wb:pane\/(.+)$/.exec(href);
  if (m) {
    let paneid = m[1];
    try {
      paneid = decodeURIComponent(paneid);
    } catch {
      /* keep it raw */
    }
    const p = d.pane(paneid);
    if (!p || !p.recipe_id || (p.state !== 'live' && p.state !== 'dehydrated')) {
      return { href, ok: false, note: 'that session is gone' };
    }
    return { href, ok: true, url: d.soloPath(p.recipe_id, paneid), label: paneid };
  }
  m = /^wb:app\/([A-Za-z0-9_-]+)\/([a-z0-9-]+)$/.exec(href);
  if (m) {
    const r = d.room(m[1]);
    if (!r || r.state !== 'open' || !d.roomHasApp(r.id, m[2])) {
      return { href, ok: false, note: 'that app is not in an open room' };
    }
    return { href, ok: true, url: roomUrl(r.id), label: `${m[2]} in ${r.name}`, room: r.id };
  }
  return { href, ok: false, note: 'not a Workbench link' };
}

/** Annotate chat items (agent replies only) with their resolved wb: links. */
export function withLinks<T extends { role: string; text: string }>(items: T[], d: LinkDeps): Array<T & { links?: WbLink[] }> {
  return items.map((i) => {
    if (i.role !== 'agent') {
      return i;
    }
    const hrefs = linksIn(i.text);
    return hrefs.length ? { ...i, links: hrefs.map((h) => resolveLink(h, d)) } : i;
  });
}
