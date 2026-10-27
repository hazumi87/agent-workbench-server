/**
 * ROOM VOICE SETTINGS (the design notes §10.1, §15) [ticket].
 *
 * A room stores only its OVERRIDES (rooms.voice, JSON); every read answers the
 * settings FULLY populated: built-in defaults < config.json `voiceDefaults` <
 * the room's overrides. So a room that never touched a key follows the
 * defaults as they are today, and an explicit choice outlives a default change.
 *
 * NULL IS A VALUE, NOT "KEEP". `character:null` means "the room default"; an
 * ABSENT key is what leaves a setting alone (the per-key merge). That is the
 * COALESCE trap (setPrefs) avoided on purpose.
 *
 * v3.6 (Owner 2026-09-29): THE USER'S GLOBALS vs THE ROOM'S OWN KEYS. A
 * person stores the GLOBAL keys once (room_user_prefs.voice, PATCH
 * /api/rooms/me); a room stores only its four (rooms.voice). `enabled` is on
 * both sides and the global one is a MASTER switch (combineVoice).
 *
 * Pure: no db, no store import (the store maps VoiceSettingsError to its own
 * RoomError, 400 naming `voice.<key>`).
 */
import { readFileSync, statSync } from 'node:fs';
import { instancePath } from './data-dir.ts';

export type VoiceParaphrase = 'off' | 'subtle' | 'full';
export const VOICE_PARAPHRASES: readonly VoiceParaphrase[] = ['off', 'subtle', 'full'];
export const VOICE_INPUTS = ['echo', 'desktop', 'browser'] as const;
export type VoiceInput = (typeof VOICE_INPUTS)[number];

export interface RoomVoiceSettings {
  enabled: boolean;
  /** An opaque the voice service character id, or null = the room default. */
  character: string | null;
  paraphrase: VoiceParaphrase;
  wordCap: number;
  idleMinutes: number;
  /** Free text for a name STT mangles; null = none. */
  spokenName: string | null;
  inputs: Record<VoiceInput, boolean>;
  /** v3.3 security toggles: the voice service checks the speaker on connect (the engine
   *  only reports it), room inbound applies the sid allowlist, the idle
   *  sweep may close the connection. */
  idOnConnect: boolean;
  idInRoom: boolean;
  idleDisconnect: boolean;
  /** v3.4: every room reply asks the voice service to reopen the mic (expectsReply). */
  openMic: boolean;
}

/** What a room or a person stores: any subset, `inputs` itself partial. */
export type RoomVoiceOverrides = Partial<Omit<RoomVoiceSettings, 'inputs'>> & { inputs?: Partial<Record<VoiceInput, boolean>> };

/** v3.6: the person's keys (every room) and the room's own. */
export const VOICE_GLOBAL_KEYS = ['enabled', 'wordCap', 'idleDisconnect', 'idleMinutes', 'inputs', 'openMic', 'idOnConnect', 'idInRoom'] as const;
export const VOICE_ROOM_KEYS = ['enabled', 'character', 'paraphrase', 'spokenName'] as const;
export type VoiceGlobals = Pick<RoomVoiceSettings, (typeof VOICE_GLOBAL_KEYS)[number]>;
export type RoomVoiceOwn = Pick<RoomVoiceSettings, (typeof VOICE_ROOM_KEYS)[number]>;
export type VoiceScope = 'global' | 'room';
const KEYS_OF: Record<VoiceScope, readonly string[]> = { global: VOICE_GLOBAL_KEYS, room: VOICE_ROOM_KEYS };

/** The keys of one scope, taken from full settings or from overrides. */
export function pickVoice(v: RoomVoiceSettings, scope: 'room'): RoomVoiceOwn;
export function pickVoice(v: RoomVoiceSettings, scope: 'global'): VoiceGlobals;
export function pickVoice(v: RoomVoiceOverrides, scope: VoiceScope): RoomVoiceOverrides;
export function pickVoice(v: RoomVoiceOverrides, scope: VoiceScope): RoomVoiceOverrides {
  return Object.fromEntries(Object.entries(v).filter(([k]) => KEYS_OF[scope].includes(k)));
}

/** EFFECTIVE settings: the person's globals with the room's four keys over
 *  them. `enabled` is the AND of both: the global switch is a master switch. */
export function combineVoice(g: VoiceGlobals, r: RoomVoiceOwn): RoomVoiceSettings {
  return { ...g, ...r, enabled: g.enabled && r.enabled };
}

const BUILTIN: RoomVoiceSettings = Object.freeze({
  enabled: true,
  character: null,
  paraphrase: 'off',
  wordCap: 40,
  idleMinutes: 30,
  spokenName: null,
  inputs: Object.freeze({ echo: true, desktop: false, browser: false }),
  idOnConnect: true,
  idInRoom: true,
  idleDisconnect: true,
  openMic: true,
}) as RoomVoiceSettings;

export class VoiceSettingsError extends Error {
  readonly field: string;
  constructor(key: string, message: string, bare = false) {
    const field = key ? `voice.${key}` : 'voice';
    super(bare ? message : `${field}: ${message}`);
    this.field = field;
  }
}

const int = (key: string, v: unknown, lo: number, hi: number): number => {
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) {
    throw new VoiceSettingsError(key, `an integer ${lo}-${hi}`);
  }
  return v as number;
};

/** One key, validated and normalised. Throws VoiceSettingsError. */
function validKey(key: string, v: unknown): unknown {
  switch (key) {
    case 'enabled':
    case 'idOnConnect':
    case 'idInRoom':
    case 'idleDisconnect':
    case 'openMic':
      if (typeof v !== 'boolean') {
        throw new VoiceSettingsError(key, 'true or false');
      }
      return v;
    case 'character':
      if (v !== null && (typeof v !== 'string' || !v || v.length > 80)) {
        throw new VoiceSettingsError(key, 'a character id (1-80 chars) or null for the room default');
      }
      return v;
    case 'paraphrase':
      if (!(VOICE_PARAPHRASES as readonly unknown[]).includes(v)) {
        throw new VoiceSettingsError(key, `one of ${VOICE_PARAPHRASES.join(' / ')}`);
      }
      return v;
    case 'wordCap':
      return int(key, v, 15, 120);
    case 'idleMinutes':
      return int(key, v, 5, 240);
    case 'spokenName': {
      if (v !== null && typeof v !== 'string') {
        throw new VoiceSettingsError(key, 'a name (<= 60 chars) or null');
      }
      const s = v === null ? '' : v.trim();
      if (s.length > 60) {
        throw new VoiceSettingsError(key, 'a name (<= 60 chars) or null');
      }
      return s || null; // blank is "none": one right answer
    }
    case 'inputs': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new VoiceSettingsError(key, `an object of ${VOICE_INPUTS.join(' / ')} booleans`);
      }
      const out: Partial<Record<VoiceInput, boolean>> = {};
      for (const [k, b] of Object.entries(v)) {
        if (!(VOICE_INPUTS as readonly string[]).includes(k) || typeof b !== 'boolean') {
          throw new VoiceSettingsError(key, `an object of ${VOICE_INPUTS.join(' / ')} booleans`);
        }
        out[k as VoiceInput] = b;
      }
      return out;
    }
    default:
      throw new VoiceSettingsError(key.slice(0, 40), 'not a voice setting');
  }
}

/** A PATCH's `voice` object → the normalised keys it carries (absent keys
 *  absent). Throws VoiceSettingsError naming the first bad key; a key of the
 *  OTHER scope is refused by name, before its value is looked at. */
export function validVoicePatch(v: unknown, scope: VoiceScope): RoomVoiceOverrides {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new VoiceSettingsError('', 'an object of voice settings');
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!KEYS_OF[scope].includes(k) && KEYS_OF[scope === 'room' ? 'global' : 'room'].includes(k)) {
      throw new VoiceSettingsError(
        k,
        scope === 'room'
          ? `${k} is a global voice setting: set it in your Settings (PATCH /api/rooms/me)`
          : `${k} is a room voice setting: set it in the room's settings (PATCH /api/rooms/:id/settings)`,
        true,
      );
    }
    out[k] = validKey(k, val);
  }
  return out as RoomVoiceOverrides;
}

/** Overrides layered on a base, per key (inputs per key too). */
export function mergeVoice(base: RoomVoiceSettings, over: RoomVoiceOverrides): RoomVoiceSettings {
  return { ...base, ...over, inputs: { ...base.inputs, ...(over.inputs ?? {}) } };
}

/** A stored override set with a patch over it (the per-key merge of a PATCH). */
export function layerOverrides(old: RoomVoiceOverrides, set: RoomVoiceOverrides): RoomVoiceOverrides {
  const next: RoomVoiceOverrides = { ...old, ...set };
  if (old.inputs || set.inputs) {
    next.inputs = { ...(old.inputs ?? {}), ...(set.inputs ?? {}) };
  }
  return next;
}

/* config.json `voiceDefaults`, re-read when the file's mtime moves (the same
   file + test override as panel-url.ts / runtime-flags.ts). A key that fails
   validation is skipped: a typo in config never breaks a room read. */
const configPath = (): string => process.env.HARBOR_WB_CONFIG || instancePath('config.json');
let cached: { path: string; mtime: number; value: RoomVoiceSettings } | null = null;

/** The defaults a room without overrides reads, fully populated. */
export function voiceDefaults(): RoomVoiceSettings {
  const path = configPath();
  let mtime = -1;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    /* no config.json: the built-ins */
  }
  if (cached && cached.path === path && cached.mtime === mtime) {
    return cached.value;
  }
  const over: Record<string, unknown> = {};
  try {
    const cfg = mtime < 0 ? null : JSON.parse(readFileSync(path, 'utf8'))?.voiceDefaults;
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      for (const [k, v] of Object.entries(cfg)) {
        try {
          over[k] = validKey(k, v);
        } catch {
          /* skipped: see above */
        }
      }
    }
  } catch {
    /* unparseable: the built-ins */
  }
  cached = { path, mtime, value: mergeVoice(BUILTIN, over as RoomVoiceOverrides) };
  return cached.value;
}
