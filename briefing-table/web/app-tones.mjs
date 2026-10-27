/* APP TITLE-BAR TONES (hub V2, Owner 2026-10-05; handoff §1 D4). Each app's cell
 * in a room's rail wears ONE identity tone (the design system --id-*; categorisation, never
 * the seven function colours). The DEFAULT is the ticket table below (moved
 * here from web/room-cells.mjs so the Settings page can show it without loading
 * the whole rail); a person's override (GET /api/rooms/me `tones`, {key: tone})
 * wins over it. The Seats bar is not an app: it always wears the room color.
 * There is NO per-room override.
 *
 * KEYS. The override key is the tool's canonical name (tasks, assets, studio,
 * voice, model) or, for any other app, its slug. Pure: no DOM, no fetch. */
export const TONES = ['cobalt', 'green', 'orchid', 'violet', 'orange'];
export const TOOL_TONE = {
  tasks: 'cobalt', list: 'cobalt', 'room-tasks': 'cobalt',
  assets: 'green', 'room-assets': 'green',
  'image-studio': 'orchid', image: 'orchid', images: 'orchid',
  voice: 'violet', 'room-voice': 'violet',
  'model-studio': 'orange', mesh: 'orange',
};
/** every spelling of a built-in tool -> its canonical override key */
const TONE_KEY = {
  tasks: 'tasks', list: 'tasks', 'room-tasks': 'tasks',
  assets: 'assets', 'room-assets': 'assets',
  'image-studio': 'studio', image: 'studio', images: 'studio',
  voice: 'voice', 'room-voice': 'voice',
  'model-studio': 'model', mesh: 'model',
};
/** The built-in tools the Settings summary lists, in rail order. */
export const BUILTIN_APPS = [
  { key: 'tasks', name: 'Tasks', tone: 'cobalt' },
  { key: 'assets', name: 'Assets', tone: 'green' },
  { key: 'studio', name: 'Image Studio', tone: 'orchid' },
  { key: 'voice', name: 'Voice', tone: 'violet' },
  { key: 'model', name: 'Model Studio', tone: 'orange' },
];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const keysOf = (p) => [p && p.app_slug, p && p.icon, String((p && p.title) || '').trim().toLowerCase().replace(/\s+/g, '-')].filter(Boolean);

/** The override key for a panel / app ({app_slug|slug, icon, title|name}). */
export function toneKey(p) {
  const q = p && p.slug && !p.app_slug ? { app_slug: p.slug, title: p.name } : p;
  const keys = keysOf(q);
  for (const k of keys) {
    if (has(TONE_KEY, k)) {
      return TONE_KEY[k];
    }
  }
  return keys[0] || String((q && q.id) || '');
}

/** The default tone: the table, else the key hashed into the five. */
export function defaultTone(p) {
  const q = p && p.slug && !p.app_slug ? { app_slug: p.slug, title: p.name } : p;
  const keys = keysOf(q);
  for (const k of keys) {
    if (has(TOOL_TONE, k)) {
      return TOOL_TONE[k];
    }
  }
  const seed = keys[0] || String((q && q.id) || '');
  let h = 0;
  for (const ch of seed) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return TONES[h % TONES.length];
}

/** The tone an app wears: the person's override, else the default. A stored
 *  value that is not one of the five is ignored, never painted. */
export function toneFor(p, overrides) {
  const key = toneKey(p);
  const ov = overrides && typeof overrides === 'object' && has(overrides, key) ? overrides[key] : null;
  return TONES.includes(ov) ? ov : defaultTone(p);
}
