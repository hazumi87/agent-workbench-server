/* The consent core (ported from workbench-app src/module-consent.js; tool maintainers' consent rule [ref], accepted [ref]; the design system words [ref] and [ref]).
 * A user-folder module (a hand-placed folder or a zip) arrives OFF and can be turned on only with a consent record (modules.<id>.consent) that pins the
 * gated grants it asks for (concierge.send, concierge.read, microphone, any rooms.tasks.*, service; possibly none), their words, the folder hash and the
 * install: it asks once even with nothing gated (lead [ref]). Any change (a new grant, other files, a reinstall) holds it again. Bundled modules stay
 * on. Turning a module off never asks. Pure: no fs; the caller hashes the folder and stores the record. test/modules-consent.test.ts. */

/** The gated grants in display order, with their plain words (the design system judges the wording). */
export const WORDS: Readonly<Record<string, string>> = {
  'concierge.send': 'send messages as you through Concierge',
  'concierge.read': 'read your Concierge conversations',
  microphone: 'use your microphone',
  'rooms.tasks.read': "read your rooms' tasks",
  'rooms.tasks.write': "add and change your rooms' tasks",
  'rooms.tasks.delete': "delete your rooms' tasks",
  service: 'run a program in the background on this PC',
};
const ORDER = Object.keys(WORDS);
const TASKS_ANY = "work with your rooms' tasks"; // a rooms.tasks.* grant without its own words
const HASH = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CHIP = 'Needs your OK';
export const ZIP_HELD = 'Installed from a zip. Not allowed yet.'; // the design system [ref]
export const FOLDER_HELD = 'Added to the plugins folder by hand. Not allowed yet. Review… to allow it.'; // a hand-placed folder or one present at the upgrade (the design system [ref])

const isGated = (p: unknown): p is string => typeof p === 'string' && (Object.prototype.hasOwnProperty.call(WORDS, p) || /^rooms\.tasks\.[a-z][a-z-]{0,30}$/.test(p));
const rank = (p: string): number => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.indexOf('rooms.tasks.delete') + 0.5);

/** The gated grants a manifest asks for, de-duplicated, in display order. */
export function gatedGrants(man: { permissions?: unknown } | null | undefined): string[] {
  const perms: unknown[] = man && Array.isArray(man.permissions) ? man.permissions : [];
  return [...new Set(perms.filter(isGated))].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** "a, b and c" from the grants' words, in display order whatever order they come in. */
export function wantsText(grants: readonly string[]): string {
  const words = [...new Set(gatedGrants({ permissions: grants }).map((g) => WORDS[g] || TASKS_ANY))];
  return words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

/** The off-to-on dialog, in the design system words. */
export function dialogText(name: string, grants: readonly string[]): { title: string; body: string; cancel: string; allow: string } {
  const body = gatedGrants({ permissions: grants }).length ? `${name} wants to: ${wantsText(grants)}. Only allow tools you trust.` : `${name} doesn't ask for anything that needs your OK. Only allow tools you trust.`;
  return { title: `Allow ${name}?`, body, cancel: 'Cancel', allow: 'Allow' };
}

/** A zip install's per-file hashes (slice 3, lead [ref]): optional; when present, a plain map of safe paths to sha256. */
const FILE_PATH = /^[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/;
export function filesOk(f: unknown): f is Record<string, string> | undefined {
  if (f === undefined) return true;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  const o = f as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length <= 2000 && keys.every((k) => k.length <= 200 && FILE_PATH.test(k) && !k.split('/').some((p) => p === '.' || p === '..') && typeof o[k] === 'string' && HASH.test(o[k] as string));
}

export interface ConsentRecord {
  grants: string[];
  words: string;
  hash: string;
  installSeq: number;
  at: string;
  files?: Record<string, string>;
}

/** Is this a consent record the host wrote? config.json is untrusted: anything else counts as none. */
export function recordOk(rec: unknown): rec is ConsentRecord {
  const r = rec as Record<string, unknown> | null | undefined;
  return (
    filesOk(r && r.files) &&
    !!r && typeof r === 'object' && !Array.isArray(r) &&
    Array.isArray(r.grants) && r.grants.every(isGated) &&
    typeof r.words === 'string' && r.words.length <= 600 &&
    typeof r.hash === 'string' && HASH.test(r.hash) &&
    Number.isInteger(r.installSeq) && (r.installSeq as number) >= 0 &&
    typeof r.at === 'string' && ISO.test(r.at)
  );
}

export interface ConsentEntry {
  source?: string;
  man?: { permissions?: unknown } | null;
  folderHash?: unknown;
  installSeq: number;
  fileHashes?: unknown;
}

/** The record to store when the person presses Allow. */
export function makeRecord(entry: ConsentEntry, nowIso: string): ConsentRecord {
  if (typeof entry.folderHash !== 'string' || !HASH.test(entry.folderHash)) {
    throw new Error('consent needs the folder hash');
  }
  const grants = gatedGrants(entry.man);
  const rec: ConsentRecord = { grants, words: wantsText(grants), hash: entry.folderHash, installSeq: entry.installSeq, at: nowIso };
  if (entry.fileHashes !== undefined) {
    if (!filesOk(entry.fileHashes)) throw new Error('consent needs a valid file list');
    rec.files = { ...entry.fileHashes };
  }
  return rec;
}

export type ConsentStateName = 'bundled' | 'not-allowed' | 'needs-ok' | 'held' | 'ok';
export interface ConsentState {
  state: ConsentStateName;
  mayEnable: boolean;
  chip: string | null;
  wants: string | null;
  reason: string | null;
  grants: string[];
}

/**
 * What the Tools tab shows and whether the module may be turned on.
 * entry: {source: 'bundled'|'user', man, folderHash, installSeq}; rec: modules.<id>.consent or null.
 */
export function consentState(entry: ConsentEntry, rec: unknown): ConsentState {
  const grants = gatedGrants(entry.man);
  const base = { grants, chip: null, wants: null, reason: null };
  if (entry.source === 'bundled') return { ...base, state: 'bundled', mayEnable: true };
  // every user module asks once, even with nothing gated (the design system [ref], lead [ref]): its files are pinned
  const off = { ...base, mayEnable: false, chip: CHIP, wants: grants.length ? `Wants to: ${wantsText(grants)}.` : null };
  if (!recordOk(rec)) return { ...off, state: grants.length ? 'needs-ok' : 'not-allowed', reason: entry.installSeq >= 1 ? ZIP_HELD : FOLDER_HELD };
  if (!grants.every((g) => rec.grants.includes(g))) return { ...off, state: 'held', reason: 'It asks for more than you allowed.' };
  if (typeof entry.folderHash !== 'string' || !HASH.test(entry.folderHash) || entry.folderHash !== rec.hash) return { ...off, state: 'held', reason: 'Its files changed since you allowed it.' };
  if (entry.installSeq !== rec.installSeq) return { ...off, state: 'held', reason: 'It was installed again since you allowed it.' };
  return { ...base, state: 'ok', mayEnable: true };
}

/** Turning a module off never asks (the design system [ref]). */
export function offNeedsConsent(): boolean {
  return false;
}
