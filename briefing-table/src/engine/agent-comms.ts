/**
 * AGENT COMMS settings [agent comms] (Owner 2026-10-07, after phase 1+2 of chatter
 * regulation: "we over-corrected"). Every chatter rule is a switch in Settings ->
 * Agent comms, and the DEFAULT is monitor-only: a rule in 'watch' is evaluated and
 * recorded (`watch_<kind>` in chatter_events; the report's `watched`) but the line
 * or message goes through unchanged. Only 'enforce' refuses. SYSTEM-wide, one
 * engine_settings object (the idle-rest pattern: a strict PATCH validator, a
 * lenient reader).
 *
 *   ackOnly / leadEcho / dmBudget / dmRepeat   'off' | 'watch' | 'enforce'
 *   dmPerHour        the DM budget, 1..1000 (HARBOR_WB_DM_BUDGET_PER_HOUR is only the
 *                    fallback when nothing is stored)
 *   quietEnabled     false = quiet marks are kept but ignored at both doors
 *   leadRules        the lead hint + the lead's welcome rules
 *   codexOneQueued   room-typer's one-queued hold + person-first cross-room batch
 *   codexSteerControl  a STOP from the person / a lead, or the answer to the pane's own
 *                    open ask, is typed into a queueing CLI's RUNNING turn (its steer
 *                    key) ahead of the queue and past the one-queued hold
 *   digestOver       0..100 (0 = off): more than this many lines addressed to a pane
 *                    waiting at delivery = ONE digest line instead of the batch
 *                    (room-typer maybeDigest); the person's and control lines stay in full
 *   unaddressedToLead a room line that names nobody goes to the lead (default) or to no seat
 *   personWakes      the person's line to a disconnected (restorable) seat wakes it and is
 *                    delivered once it is up (default on) [wake deliver]
 *   personWakeScope  which disconnected seats the person's line wakes: 'all', or 'auto' = only
 *                    those the system rested (idle) or lost, never one the person disconnected
 *   replyInherits    an agent's line that names nobody, right after the person's line to it,
 *                    answers that line (reply_to + to the person), not the lead [reply route]
 */
import { table } from '../table/endpoint.ts';
import { dmBudgetPerHour } from './chatter.ts';

export type WakeScope = 'all' | 'auto';
export const WAKE_SCOPES: readonly WakeScope[] = ['all', 'auto'];
export type RuleMode = 'off' | 'watch' | 'enforce';
export const RULE_MODES: readonly RuleMode[] = ['off', 'watch', 'enforce'];
export const RULE_KEYS = ['ackOnly', 'leadEcho', 'dmBudget', 'dmRepeat'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];
const FLAG_KEYS = ['quietEnabled', 'leadRules', 'codexOneQueued', 'codexSteerControl', 'unaddressedToLead', 'personWakes', 'replyInherits'] as const;

export interface AgentComms {
  ackOnly: RuleMode;
  leadEcho: RuleMode;
  dmBudget: RuleMode;
  dmRepeat: RuleMode;
  dmPerHour: number;
  quietEnabled: boolean;
  leadRules: boolean;
  codexOneQueued: boolean;
  codexSteerControl: boolean;
  digestOver: number;
  /** [address only] a room line that names nobody goes to the lead (true) or to no seat. */
  unaddressedToLead: boolean;
  /** [wake deliver] the person's line wakes a disconnected seat and is delivered after. */
  personWakes: boolean;
  /** [wake deliver] with personWakes on: wake every disconnected seat, or only the auto-disconnected / resting ones. */
  personWakeScope: WakeScope;
  /** [reply route] an agent's unaddressed line answers the person's open line to it. */
  replyInherits: boolean;
}

/* M7 (security review): the rule guards ENFORCE by default; 'watch' (log only) is a choice a person makes in Settings. */
export const AGENT_COMMS_DEFAULTS: Readonly<AgentComms> = Object.freeze({
  ackOnly: 'enforce',
  leadEcho: 'enforce',
  dmBudget: 'enforce',
  dmRepeat: 'enforce',
  dmPerHour: 6,
  quietEnabled: true,
  leadRules: false,
  codexOneQueued: true,
  codexSteerControl: true,
  digestOver: 4,
  unaddressedToLead: true,
  personWakes: true,
  personWakeScope: 'all',
  replyInherits: true,
});

export const DM_PER_HOUR_MAX = 1000;
export const DIGEST_OVER_MAX = 100;
const SETTING_KEY = 'agentComms';

export class AgentCommsError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

function validPerHour(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > DM_PER_HOUR_MAX) {
    throw new AgentCommsError('dmPerHour', `a whole number, 1 to ${DM_PER_HOUR_MAX}`);
  }
  return v;
}

function validDigestOver(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > DIGEST_OVER_MAX) {
    throw new AgentCommsError('digestOver', `a whole number, 0 (off) to ${DIGEST_OVER_MAX}`);
  }
  return v;
}

/** A PATCH body, validated: only known keys, each checked. Throws AgentCommsError. */
export function validAgentCommsPatch(b: unknown): Partial<AgentComms> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new AgentCommsError('body', 'an object of agent-comms settings');
  }
  const o = b as Record<string, unknown>;
  const out: Partial<AgentComms> = {};
  for (const k of RULE_KEYS) {
    if (o[k] !== undefined) {
      if (!RULE_MODES.includes(o[k] as RuleMode)) {
        throw new AgentCommsError(k, 'off, watch or enforce');
      }
      out[k] = o[k] as RuleMode;
    }
  }
  if (o.dmPerHour !== undefined) {
    out.dmPerHour = validPerHour(o.dmPerHour);
  }
  if (o.digestOver !== undefined) {
    out.digestOver = validDigestOver(o.digestOver);
  }
  for (const k of FLAG_KEYS) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'boolean') {
        throw new AgentCommsError(k, 'true or false');
      }
      out[k] = o[k] as boolean;
    }
  }
  if (o.personWakeScope !== undefined) {
    if (!WAKE_SCOPES.includes(o.personWakeScope as WakeScope)) {
      throw new AgentCommsError('personWakeScope', 'all or auto');
    }
    out.personWakeScope = o.personWakeScope as WakeScope;
  }
  const known = new Set<string>([...RULE_KEYS, 'dmPerHour', 'digestOver', 'personWakeScope', ...FLAG_KEYS]);
  const stray = Object.keys(o).find((k) => !known.has(k));
  if (stray) {
    throw new AgentCommsError(stray, 'not an agent-comms setting');
  }
  if (!Object.keys(out).length) {
    throw new AgentCommsError('body', 'carries no setting');
  }
  return out;
}

/** A stored value read back leniently: anything unreadable falls to the default. */
export function agentCommsFrom(raw: unknown): AgentComms {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: AgentComms = { ...AGENT_COMMS_DEFAULTS, dmPerHour: dmBudgetPerHour() };
  for (const k of RULE_KEYS) {
    if (RULE_MODES.includes(o[k] as RuleMode)) {
      out[k] = o[k] as RuleMode;
    }
  }
  try {
    if (o.dmPerHour !== undefined) {
      out.dmPerHour = validPerHour(o.dmPerHour);
    }
  } catch {
    /* the fallback stands */
  }
  try {
    if (o.digestOver !== undefined) {
      out.digestOver = validDigestOver(o.digestOver);
    }
  } catch {
    /* the default stands */
  }
  if (WAKE_SCOPES.includes(o.personWakeScope as WakeScope)) {
    out.personWakeScope = o.personWakeScope as WakeScope;
  }
  for (const k of FLAG_KEYS) {
    if (typeof o[k] === 'boolean') {
      out[k] = o[k] as boolean;
    }
  }
  return out;
}

/** The live settings (read per decision: a Save applies at once, no restart). */
export function agentComms(): AgentComms {
  try {
    return agentCommsFrom(table.getEngineSetting(SETTING_KEY));
  } catch {
    return agentCommsFrom(null);
  }
}

export function setAgentComms(patch: Partial<AgentComms>): AgentComms {
  const next = { ...agentComms(), ...patch };
  table.setEngineSetting(SETTING_KEY, next);
  return next;
}
