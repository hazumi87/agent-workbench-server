/**
 * GLOBAL COLOR PALETTE + APP TITLE-BAR TONES (hub V2, Owner 2026-10-05; handoff
 * §1 D). Per PERSON (room_user_prefs.palette / .tones), every room and app.
 *
 * The palette KEYS are the list in web/palette.mjs (the generator ships to the
 * browser; the engine only has to know which keys are real, so a bad write is a
 * 400 rather than a page that silently falls back). Keep the two lists equal:
 * test/palette-prefs.test.mjs compares them.
 *
 * Pure: no db, no store import (the store maps PaletteError to its RoomError).
 */
export const PALETTE_KEYS: readonly string[] = [
  'aurora', 'neutral', 'greyscale', 'gold', 'pastel', 'caribbean', 'reef', 'lagoon', 'sky', 'ocean', 'glacier',
  'sunset', 'fall', 'spring', 'summer', 'winter', 'forest', 'midnight', 'rose', 'contrast', 'custom',
];
export const PALETTE_MODES: readonly string[] = ['dark', 'light'];
/** The five identity tones (the design system --id-*) a title bar can wear. */
export const TONES: readonly string[] = ['cobalt', 'green', 'orchid', 'violet', 'orange'];
/** The ten colors a custom palette carries (web/palette.mjs `keys`). */
export const CUSTOM_KEYS: readonly string[] = ['ink', 'surface', 'text', 'accent', 'neutral', ...TONES];

export interface PalettePref {
  key: string;
  mode: 'dark' | 'light';
  /** The person's own ten colors, kept even while another palette is chosen. */
  custom?: Record<string, string>;
}
export type TonePrefs = Record<string, string>;

export const DEFAULT_PALETTE: PalettePref = { key: 'aurora', mode: 'dark' };

export class PaletteError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'PaletteError';
    this.field = field;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const APP_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A palette pref, validated and normalized (hex lowercased). Never clamps. */
export function validPalette(raw: unknown): PalettePref {
  if (!isObj(raw)) {
    throw new PaletteError('palette is {key, mode, custom?}', 'palette');
  }
  const { key, mode, custom } = raw;
  if (typeof key !== 'string' || !PALETTE_KEYS.includes(key)) {
    throw new PaletteError(`palette.key is one of: ${PALETTE_KEYS.join(', ')}`, 'palette.key');
  }
  if (typeof mode !== 'string' || !PALETTE_MODES.includes(mode)) {
    throw new PaletteError('palette.mode is dark or light', 'palette.mode');
  }
  const out: PalettePref = { key, mode: mode as 'dark' | 'light' };
  if (custom !== undefined && custom !== null) {
    if (!isObj(custom)) {
      throw new PaletteError('palette.custom is an object of #rrggbb colors', 'palette.custom');
    }
    const c: Record<string, string> = {};
    for (const k of Object.keys(custom)) {
      if (!CUSTOM_KEYS.includes(k)) {
        throw new PaletteError(`palette.custom.${k} is not a palette color (${CUSTOM_KEYS.join(', ')})`, `palette.custom.${k}`);
      }
    }
    for (const k of CUSTOM_KEYS) {
      const v = custom[k];
      if (typeof v !== 'string' || !HEX.test(v)) {
        throw new PaletteError(`palette.custom.${k} is a #rrggbb color`, `palette.custom.${k}`);
      }
      c[k] = v.toLowerCase();
    }
    out.custom = c;
  }
  return out;
}

/** A tones PATCH: {app: tone}; a null tone clears that app's override (back to
 *  its default). Per-key merge, like voice. Returns the validated patch. */
export function validTonesPatch(raw: unknown): Record<string, string | null> {
  if (!isObj(raw)) {
    throw new PaletteError('tones is an object of app: tone', 'tones');
  }
  const out: Record<string, string | null> = {};
  for (const [app, tone] of Object.entries(raw)) {
    if (!APP_KEY.test(app)) {
      throw new PaletteError(`tones.${app}: an app key is lowercase letters, digits, - or _`, `tones.${app}`);
    }
    if (tone === null) {
      out[app] = null;
    } else if (typeof tone === 'string' && TONES.includes(tone)) {
      out[app] = tone;
    } else {
      throw new PaletteError(`tones.${app} is one of: ${TONES.join(', ')} (or null to clear)`, `tones.${app}`);
    }
  }
  return out;
}

/** AUTO ROOM COLOURS: the swatch (0-11) each room was first assigned for THIS person, so every surface shows the same colour. At most this many rooms are remembered. */
export const ROOM_COLORS_MAX = 200;
export const ROOM_SWATCHES = 12;
export type RoomColorPrefs = Record<string, number>;
const ROOM_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A roomColors PATCH: {roomId: swatch index 0-11, or null to forget that room}. Per-key merge, like tones. */
export function validRoomColorsPatch(raw: unknown): Record<string, number | null> {
  if (!isObj(raw)) {
    throw new PaletteError('roomColors is an object of roomId: swatch index (0-11, or null to clear)', 'roomColors');
  }
  const out: Record<string, number | null> = {};
  for (const [room, v] of Object.entries(raw)) {
    if (!ROOM_KEY.test(room)) {
      throw new PaletteError(`roomColors.${room}: a key is a room id`, `roomColors.${room}`);
    }
    if (v === null) {
      out[room] = null;
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ROOM_SWATCHES) {
      out[room] = v;
    } else {
      throw new PaletteError(`roomColors.${room} is a swatch index from 0 to ${ROOM_SWATCHES - 1} (or null to clear)`, `roomColors.${room}`);
    }
  }
  return out;
}
