/* Plugin install, the gate (ported from workbench-app src/plugin-gate.js; the design notes C2-C4, revision 1, lead [ref];
 * the design notes M6): the engine's decisions for one catalog entry, pure. Bundled modules keep today's behaviour and are the only ones that
 * run `main` in the app page. A user module (a hand-placed folder or a zip) runs UI only in sandboxed frames, is on only when its consent record matches
 * what is on disk now (consent.ts), can't be switched on without one, and is allowed only with a pin equal to the folder hash computed at this scan.
 * Off never asks. test/modules-plugin-gate.test.ts. */
import * as consent from './consent.ts';
import type { ConsentEntry, ConsentRecord } from './consent.ts';

/** A catalog entry as the scan builds it. */
export interface GateModule {
  id?: string;
  source?: string;
  name?: string;
  version?: string;
  author?: string;
  permissions?: unknown[];
  defaultEnabled?: boolean;
  core?: boolean;
  folderHash?: string | null;
  installSeq?: number;
  error?: unknown;
  bytes?: number;
  /** a zip install's per-file sha256 (config modules.<id>.installFiles); pinned into the record on Allow */
  fileHashes?: unknown;
  [k: string]: unknown;
}

const isUser = (m: GateModule | null | undefined): boolean => !!m && m.source !== 'bundled';
const entryFor = (m: GateModule): ConsentEntry => ({ source: m.source, man: { permissions: m.permissions || [] }, folderHash: m.error ? null : m.folderHash, installSeq: Number.isInteger(m.installSeq) ? (m.installSeq as number) : 0 });
const stateOf = (m: GateModule, cfg: { consent?: unknown } | null | undefined): consent.ConsentState => consent.consentState(entryFor(m), cfg && cfg.consent);

export interface GateResult {
  enabled: boolean;
  runMain: boolean;
  consent: { state: consent.ConsentStateName; chip: string | null; wants: string | null; reason: string | null } | null;
}

/** {enabled, runMain, consent} for the module state. cfg is config.modules[id] (untrusted). */
export function gateEntry(m: GateModule, cfg: unknown): GateResult {
  const c = (cfg && typeof cfg === 'object' ? cfg : {}) as { enabled?: unknown; consent?: unknown };
  if (!isUser(m)) return { enabled: m.core ? true : typeof c.enabled === 'boolean' ? c.enabled : !!m.defaultEnabled, runMain: true, consent: null };
  const s = stateOf(m, c);
  return { enabled: c.enabled === true && s.mayEnable, runMain: false, consent: { state: s.state, chip: s.chip, wants: s.wants, reason: s.reason } };
}

/** May the module be switched on? A user module needs a record matching the disk now. */
export const mayTurnOn = (m: GateModule, cfg?: { consent?: unknown } | null): boolean => !isUser(m) || stateOf(m, cfg || {}).mayEnable;
/** Turning anything off never asks. */
export const mayTurnOff = (_m?: GateModule, _cfg?: unknown): boolean => consent.offNeedsConsent() === false;

export type ReviewResult =
  | { ok: true; dialog: ReturnType<typeof consent.dialogText>; facts: { version: string | null; by: string | null; bytes: number | null }; pin: string }
  | { ok: false; reason: 'not-a-plugin' | 'unreadable' };

/** The Allow dialog for a user module, pinned to the folder hash of this scan. */
export function review(m: GateModule): ReviewResult {
  if (!isUser(m)) return { ok: false, reason: 'not-a-plugin' };
  const e = entryFor(m);
  if (!e.folderHash) return { ok: false, reason: 'unreadable' };
  const grants = consent.gatedGrants(e.man);
  return { ok: true, dialog: consent.dialogText(m.name || m.id || '', grants), facts: { version: m.version || null, by: m.author || null, bytes: Number.isInteger(m.bytes) ? (m.bytes as number) : null }, pin: e.folderHash as string };
}

/** The person pressed Allow on a dialog pinned to `pin`: the record to store, or why not. */
export function allow(m: GateModule, pin: unknown, nowIso: string): { ok: true; record: ConsentRecord } | { ok: false; reason: 'not-a-plugin' | 'unreadable' | 'stale-pin' | 'bad-file-hashes' } {
  if (!isUser(m)) return { ok: false, reason: 'not-a-plugin' };
  const e = entryFor(m);
  if (!e.folderHash) return { ok: false, reason: 'unreadable' };
  if (pin !== e.folderHash) return { ok: false, reason: 'stale-pin' };
  // The app's entryFor dropped fileHashes, so the record never carried the zip's per-file pins that M1 serves by (the design notes §5, P8); carried here.
  if (m.fileHashes !== undefined) {
    if (!consent.filesOk(m.fileHashes)) return { ok: false, reason: 'bad-file-hashes' };
    e.fileHashes = m.fileHashes;
  }
  return { ok: true, record: consent.makeRecord(e, nowIso) };
}
