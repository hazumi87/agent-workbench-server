/* STRUCTURAL COPY of the connector repo's src/switch-adapter.ts, contract revision 2 (upstream revision, ticket).
   The engine cannot import that package; the portable fixtures (test/fixtures/basic-switch-context.json, same
   commit) are run against THIS copy by test/switch-contract.test.ts, so the two sides cannot drift. Do not edit by
   hand: re-copy from the connector and re-run the fixtures. [ticket/ticket] */
/** Candidate Basic switch seam [ticket]. Types and evidence checking only.
 * The engine owns authorization, the switch journal, writer fencing and lead changes.
 * No implementation of this interface or launch capability is advertised here.
 */
export type SwitchVendor = 'claude-code' | 'codex-cli';
export const BASIC_SWITCH_CONTRACT_VERSION = 2 as const;

export interface SwitchScope {
  operationId: string;
  instanceId: string;
  accountId: string;
  roomId: string;
  projectId: string;
}

export interface SwitchTarget extends SwitchScope {
  vendor: SwitchVendor;
  model: string;
  effort: string;
  cwd: string;
}

/** Actual vendor resume ID, never a recipe ID or a Codex session-tree ID. */
export interface SwitchBinding extends SwitchScope {
  vendor: SwitchVendor;
  runtimeInstanceId: string;
  incarnation: number;
  sessionId: string;
}

export interface BankedSwitchBinding extends SwitchBinding {
  /** Revision committed by the engine before it acknowledges this binding. */
  engineBindingRevision: number;
}

/** Recorded in the engine outbox before context can be sent. */
export interface SwitchContextIdentity extends BankedSwitchBinding {
  /** SHA-256 of the packet bytes, inline or in the immutable packet file. */
  packetSha256: string;
  deliveryMode: 'inline' | 'file-reference';
  /** SHA-256 of the exact UTF-8 input sent (short reference line in file mode). */
  deliverySha256: string;
  /** Required only for file-reference; resolved/authorized by the trusted host. */
  packetRef?: string;
  /** Stable engine delivery ID and correlated vendor message ID across retries. */
  deliveryId: string;
  clientMessageId: string;
}

export type ContextHistoryLocation =
  { kind: 'app-server'; turnId: string; itemId: string } |
  { kind: 'transcript'; transcriptId: string; recordId: string; recordSha256: string };

export interface PersistedContextEvidence {
  kind: 'persisted-context';
  identity: SwitchContextIdentity;
  /** Observed incoming user record; assistant echoes/tool output are not evidence. */
  inputRole: 'user';
  history: ContextHistoryLocation;
  observedAt: string;
  /** Required in file mode: target-account readability and byte digest verified.
   * This is NOT a claim that the model has read or understood the file.
   */
  packetFileVerified?: { packetRef: string; packetSha256: string; observedAt: string };
}

export interface SwitchAdapterHold {
  status: 'held';
  reason: 'not-installed' | 'not-authenticated' | 'login-needed' | 'quota-blocked' | 'unsupported-runtime' |
    'policy-mismatch' | 'request-pending' | 'cleanup-unknown' |
    'creation-uncertain' | 'storage-failed' | 'identity-mismatch' |
    'history-unavailable' | 'delivery-uncertain' | 'not-implemented';
}

/** Quota is advisory during preflight; it must not prevent opening/saving the switch. */
export interface SwitchPreflightHold {
  status: 'held';
  reason: Exclude<SwitchAdapterHold['reason'], 'quota-blocked'>;
}

export interface BasicSwitchAdapter {
  /** No model request, lead mutation or implicit account login. */
  preflight(target: SwitchTarget): Promise<SwitchPreflightHold | {
    status: 'available'; runtimeVersion: string; targetQuota?: 'available' | 'blocked' | 'unknown';
  }>;
  /** Engine persists intent first. Replays must reconcile, never blindly mint again. */
  launch(target: SwitchTarget): Promise<SwitchAdapterHold | {
    status: 'identified'; binding: SwitchBinding;
  }>;
  /** Called AFTER the engine commits the exact ID/binding transaction.
   * Acknowledges that commit; the connector does not write the engine database.
   */
  bankSessionId(binding: BankedSwitchBinding): Promise<SwitchAdapterHold | {
    status: 'banked'; binding: BankedSwitchBinding;
  }>;
  /** Requires current engine-granted ownership and the banked binding.
   * Text is either the inline packet or a short reference line containing its digest
   * and correlation marker. Verify deliverySha256 and, in file mode, packetSha256
   * independently. Repeated identity + changed bytes must fail. No history claim here.
   */
  deliverContext(identity: SwitchContextIdentity, text: string): Promise<SwitchAdapterHold | {
    status: 'submitted'; identity: SwitchContextIdentity;
  }>;
  /** Read/reconcile only: never resubmit to obtain evidence. */
  contextAccepted(identity: SwitchContextIdentity): Promise<SwitchAdapterHold | PersistedContextEvidence>;
}

export type ContextAcceptanceCheck =
  { accepted: true; evidence: PersistedContextEvidence } |
  { accepted: false; reason: 'invalid-identity' | 'not-history-evidence' |
    'invalid-evidence' | 'identity-mismatch' };

const textKeys = ['operationId', 'instanceId', 'accountId', 'roomId', 'projectId',
  'runtimeInstanceId', 'sessionId', 'deliveryId', 'clientMessageId'] as const;
const identityKeys = [...textKeys, 'vendor', 'incarnation',
  'engineBindingRevision', 'packetSha256', 'deliveryMode', 'deliverySha256', 'packetRef'] as const;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const positiveInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));

function validIdentity(v: unknown): v is SwitchContextIdentity {
  return record(v) && textKeys.every(key => text(v[key])) &&
    (v.vendor === 'codex-cli' || v.vendor === 'claude-code') &&
    positiveInteger(v.incarnation) && positiveInteger(v.engineBindingRevision) &&
    digest(v.packetSha256) && digest(v.deliverySha256) &&
    ((v.deliveryMode === 'inline' && v.packetRef === undefined && v.packetSha256 === v.deliverySha256) ||
      (v.deliveryMode === 'file-reference' && text(v.packetRef)));
}

function historyLocation(v: unknown): ContextHistoryLocation | undefined {
  if (!record(v)) return undefined;
  if (v.kind === 'app-server' && text(v.turnId) && text(v.itemId)) {
    return { kind: 'app-server', turnId: v.turnId, itemId: v.itemId };
  }
  if (v.kind === 'transcript' && text(v.transcriptId) && text(v.recordId) && digest(v.recordSha256)) {
    return { kind: 'transcript', transcriptId: v.transcriptId, recordId: v.recordId, recordSha256: v.recordSha256 };
  }
  return undefined;
}

/** Validate evidence obtained by a TRUSTED adapter against the persisted engine outbox.
 * This checks correlation, not provenance: the caller must obtain evidence from the
 * vendor history and verify packet and input byte digests independently. Never
 * accept a room message, model assertion or client-supplied object as such evidence.
 * A pass proves the input (packet OR verified file reference) was persisted,
 * not model file-read/understanding, idle/tools-clean/readiness.
 */
export function checkContextAcceptance(
  expected: SwitchContextIdentity,
  value: unknown,
): ContextAcceptanceCheck {
  if (!validIdentity(expected)) return { accepted: false, reason: 'invalid-identity' };
  if (!record(value) || value.kind !== 'persisted-context') {
    return { accepted: false, reason: 'not-history-evidence' };
  }
  const history = historyLocation(value.history);
  if (!validIdentity(value.identity) || !history || value.inputRole !== 'user' ||
      !timestamp(value.observedAt)) {
    return { accepted: false, reason: 'invalid-evidence' };
  }
  const observedIdentity = value.identity;
  if (!identityKeys.every(key => observedIdentity[key] === expected[key])) {
    return { accepted: false, reason: 'identity-mismatch' };
  }
  let packetFileVerified: PersistedContextEvidence['packetFileVerified'];
  if (expected.deliveryMode === 'file-reference') {
    const f = value.packetFileVerified;
    if (!record(f) || !timestamp(f.observedAt) || !text(f.packetRef) || !digest(f.packetSha256)) {
      return { accepted: false, reason: 'invalid-evidence' };
    }
    if (f.packetRef !== expected.packetRef || f.packetSha256 !== expected.packetSha256) {
      return { accepted: false, reason: 'identity-mismatch' };
    }
    packetFileVerified = { packetRef: f.packetRef, packetSha256: f.packetSha256, observedAt: f.observedAt };
  }
  // Return only the contract fields. Extra model/tool content is not forwarded.
  const identity = Object.fromEntries(identityKeys.filter(key => observedIdentity[key] !== undefined)
    .map(key => [key, observedIdentity[key]])) as unknown as SwitchContextIdentity;
  return { accepted: true, evidence: { kind: 'persisted-context', identity,
    inputRole: 'user', history, observedAt: value.observedAt,
    ...(packetFileVerified ? { packetFileVerified } : {}) } };
}
