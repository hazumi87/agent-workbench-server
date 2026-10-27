/* ============================================================================
 * SESSION PRESENCE (Stage 2 / E10) — the engine heartbeats for every CLI it
 * holds, whatever brand.
 *
 * E10: "session/viewer presence = the engine; user/device presence = a server
 * user-relay". This module is the engine's whole half of that. It publishes
 * `agent.<slug>.state` (contract §6) from the same activity machine that draws
 * the rings, which is what makes liveness VENDOR-NEUTRAL: the Claude Code
 * Notification/Stop hooks stop being the source of "is it alive" and become one
 * adapter for the ATTENTION signal only. A vendor that ships no hooks still
 * appears, because the engine can see its pty.
 *
 * PULSE PLANE, NOT THE FABRIC (plan §1b, E2). This is a plain NATS publish:
 * fire-and-forget, unaddressed, unacknowledged, no JetStream. Presence that
 * nobody heard is presence that will be published again in a moment; making it
 * durable would give the pulse plane exactly the guarantees the two-plane split
 * exists to keep out of it. Anything that must arrive goes on the message
 * fabric instead.
 *
 * NATS OFF IS NOT AN ERROR. Same posture as telemetry: if the server is unset
 * or unreachable, presence is silently skipped and the engine does not care.
 * ========================================================================== */

import * as telemetry from './telemetry.ts';
import { isSlug } from './agent-slug.ts';

/** Contract §3's vocabulary, verbatim. `disconnected` is reserved for a row the
 *  SERVER knows is restorable-but-unmanned; the activity machine never emits
 *  it, so in practice the engine publishes the other four. */
/* `background` (v21): output with no claude turn running - published as the
 *  REAL state; only the v20 renderers fold it into `streaming`. */
export type PresenceState = 'streaming' | 'background' | 'idle' | 'waiting' | 'disconnected' | 'ended';

/** The activity machine's word -> contract §3's. Identity except for
 *  `waiting-seen` (window-chrome v33, ticket: blocked on a prompt the human
 *  has seen, not answered), which is still `waiting` on the fabric: the
 *  contract's word means "a human must act before anything else", which is
 *  still true, and a consumer whose alias table predates v33 would otherwise
 *  draw an unknown word as `ended`. Seen-ness is a fact about Owner's screens,
 *  not the agent's presence. */
export function presenceStateOf(activity: string): PresenceState {
  return (activity === 'waiting-seen' ? 'waiting' : activity) as PresenceState;
}

export interface PresencePayload {
  slug: string;
  vendor: string;
  /** The service registry node slug the agent WORKS ON — the host its cwd is on,
   *  which for an ssh session is the far end, not this engine's host. */
  node: string;
  /** The incarnation, carried as LINEAGE (contract §1). Never a key. */
  paneid: string;
  state: PresenceState;
  /** Is a window/viewer currently watching (contract §3's `attached | parked`). */
  attached: boolean;
  project?: string;
  ts: string;
}

/** Last payload EMITTED per slug — what `/api/diag/presence` answers with. */
const lastBySlug = new Map<string, PresencePayload>();
/** Dedupe fingerprint per (slug, pane): presence is a state, and republishing an
 *  unchanged state on every attach/activity tick is noise on a plane that is
 *  already carrying thousands of signals. Keyed by PANE, not slug, so two panes
 *  sharing a slug cannot silence each other. */
const fingerprints = new Map<string, string>();

function key(p: PresencePayload): string {
  return `${p.slug}|${p.paneid}`;
}

/**
 * Publish one state change. Returns true if it went out (i.e. was not a
 * duplicate of this pane's last).
 *
 * A slug that is not a legal slug is DROPPED rather than sanitised: `.`, `*`
 * and `>` are NATS subject syntax, and quietly repairing a bad key here would
 * hide the place that produced it.
 */
export function publish(p: PresencePayload): boolean {
  if (!isSlug(p.slug)) {
    return false;
  }
  const fp = `${p.state}|${p.attached}|${p.vendor}|${p.node}`;
  if (fingerprints.get(key(p)) === fp) {
    return false;
  }
  fingerprints.set(key(p), fp);
  lastBySlug.set(p.slug, p);
  telemetry.publishJson(`agent.${p.slug}.state`, p);
  return true;
}

/** The session is over. Publishes `ended` and forgets the fingerprint, so the
 *  next launch of the same pane republishes its first state instead of being
 *  deduped against a dead one. */
export function end(p: Omit<PresencePayload, 'state' | 'attached'>): boolean {
  const out = publish({ ...p, state: 'ended', attached: false });
  fingerprints.delete(key({ ...p, state: 'ended', attached: false }));
  return out;
}

/** GET /api/diag/presence — the same habit as /api/diag/activity and
 *  /api/diag/viewport: make the engine STATE what it last said about an agent,
 *  rather than reasoning about why showcase is not drawing one. */
export function dump(): { nats: boolean; subject: string; agents: PresencePayload[] } {
  return {
    nats: telemetry.enabled(),
    subject: 'agent.<slug>.state',
    agents: [...lastBySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/** Tests only: forget everything (no engine caller). */
export function reset(): void {
  lastBySlug.clear();
  fingerprints.clear();
}
