/* ============================================================================
 * MCP CALLS IN FLIGHT -- the engine half of the session bar's MCP indicator
 * (ticket). The renderer is the design system window-chrome v29 `hwbMcpIndicator`
 * (web/aurora/window-chrome/hwb-mcp.js), wired by cli-manager; it shows only
 * what it is told. This module tells it.
 *
 * THE FRAME (contract agreed with cli-manager + the design system; do not rename fields),
 * pushed on the pane's multiplexed socket to every viewer, like pane.held:
 *
 *   pane.mcp { paneid, id, phase: 'start'|'end', server, label, verb,
 *              caller: { kind: 'agent'|'sub', name },
 *              result?: 'ok'|'warn'|'error', ms?,
 *              why?: 'isError'|'failed'|'denied'|'interrupted', ts }
 *
 *   id      Claude Code's tool_use_id.
 *   ts      epoch ms: when the call started (start) / ended (end). the design system v28
 *           replays a reconnecting window's in-flight starts from their ts.
 *   ms      end only: end ts minus start ts, on the engine's clock, so the
 *           chip's final time never jumps back from the elapsed it was showing.
 *   caller  sub-agent iff the hook payload carries agent_id; name = its
 *           agent_type ('subagent' if absent, over 32 chars or outside
 *           [A-Za-z0-9_:-]). The main thread is always
 *           { kind: 'agent', name: 'agent' }.
 *   server/verb  the tool name split (parseToolName): [A-Za-z0-9_-], server
 *           <= 48 chars, verb <= 64.
 *   expectEnd is never sent: every hook-sourced call has an end hook.
 * An end frame repeats the start's server/label/verb/caller. pane.ready
 * carries `mcp: inFlight(paneid)` -- the start frames still open, oldest
 * first, at most READY_MAX.
 *
 * SOURCE: Claude Code hooks posted to POST /api/claude-hook (the existing sink
 * and its session_id -> paneid correlation; nothing here correlates).
 *
 * VERIFIED against Claude Code 2.1.283 (the installed binary
 * ~/.local/share/claude/versions/2.1.283, hook-input builders read from its
 * strings; plus code.claude.com/docs/en/hooks, 2026-09-25):
 *   - PreToolUse input: tool_name, tool_input, tool_use_id (+ mcp_server
 *     {name, source} for MCP tools, unused here).
 *   - PostToolUse input: tool_name, tool_input, tool_response, tool_use_id,
 *     duration_ms.
 *   - PostToolUseFailure EXISTS: tool_name, tool_input, tool_use_id, error,
 *     is_interrupt, duration_ms.
 *   - USER ESC DELIVERS NO END (review 2026-09-25, corrected): Esc aborts the
 *     turn's signal, and the hook executor returns before running any command
 *     hook dispatched on an aborted signal (`if(h?.aborted)return`) -- so an
 *     Esc'd call gets neither PostToolUseFailure nor Stop. is_interrupt:true
 *     arrives only for an abort that did NOT abort the turn (a per-call cancel).
 *     ctrl+b "background" sends no failure hook either. Covered by idle_prompt
 *     (below), the next Stop, pane end, or the 30 min cap.
 *   - Notification carries notification_type. `idle_prompt` ("Claude is waiting
 *     for your input") is sent only when the REPL is NOT loading, no dialog is
 *     on screen, nobody has interacted since the last query completed (aborted
 *     ones included), after messageIdleNotifThresholdMs (default 60 s). So it
 *     never fires while a call waits on a permission prompt, and a user who
 *     types right after Esc gets no idle_prompt: that ghost lasts until the
 *     next Stop. No other notification_type ends anything (permission_prompt,
 *     elicitation_dialog, ... fire while a call legitimately waits).
 *   - StopFailure (a turn ended by a terminal API error): error,
 *     error_details, last_assistant_message. The query loop is shared with
 *     sub-agents, so a SUB-AGENT's failure carries its agent_id. NOT dispatched
 *     on the turn signal, so it arrives when Stop does not.
 *   - /clear and /resume fire SessionEnd while the main thread is idle, and
 *     KEEP background tasks running: their later hooks carry the NEW session
 *     id (rotated in place).
 *   - SessionEnd: reason clear | resume | logout | prompt_input_exit | other,
 *     with the ending session's id -- after /clear the row still banks it.
 *   - An MCP result with isError:true is THROWN by Claude Code
 *     (McpToolCallError "MCP tool returned error"), so in 2.1.283 it arrives
 *     as PostToolUseFailure -> error/failed, not as PostToolUse. The PostToolUse
 *     `tool_response.isError === true` -> error/isError branch is kept for
 *     versions/paths that pass it through; it costs one boolean read.
 *   - Base fields on every hook: session_id, transcript_path, cwd,
 *     permission_mode, agent_id (only inside a sub-agent), agent_type
 *     (sub-agent type, or the session's --agent). Sub-agent tool calls fire the
 *     same Pre/Post hooks with the PARENT's session_id (a sub-agent transcript
 *     carries the parent sessionId) plus agent_id -- so they correlate to the
 *     parent's pane and are marked { kind: 'sub' }.
 *   - PermissionDenied EXISTS but fires ONLY for an auto-mode classifier
 *     denial (tool_name, tool_input, tool_use_id, reason) -> warn/denied. A
 *     deny rule, a PreToolUse-hook deny or a human pressing No fires NO end
 *     hook at all: that start stays open until the main thread's next Stop, the
 *     pane ends, or the 30 min cap -- never shown as 'denied', because nothing
 *     reports it. PreToolUse fires before the permission decision, so a call
 *     waiting on a prompt reads as in flight.
 *   - UserPromptSubmit is NOT idle-only: 2.1.283 delivers messages typed while
 *     busy mid-turn (queued_command) and screens every submitted text with the
 *     UserPromptSubmit hooks, including a pre-screen at enqueue. So it is NOT
 *     used to end calls -- it would interrupt live ones.
 *   - SubagentStop carries agent_id + agent_type (same session_id).
 *
 * ENDS:
 *   PostToolUse          -> ok, or error/isError (tool_response.isError true)
 *   PostToolUseFailure   -> error/failed, or warn/interrupted (is_interrupt)
 *   PermissionDenied     -> warn/denied (warn, not error: the server was
 *                           never called, and the design system words error as "failed")
 *   Stop, Notification idle_prompt, SessionEnd, StopFailure with no agent_id
 *                        -> warn/interrupted, MAIN-THREAD calls of the session
 *   SubagentStop, StopFailure with an agent_id
 *                        -> warn/interrupted, THAT agent_id's calls, on any
 *                           pane and whatever session id the hook carries
 *                           (agent ids are unique; after /clear the agent's
 *                           hooks carry the new session id)
 * SessionEnd is main-thread only because /clear and /resume keep background
 * agents running: their calls end by their own PostToolUse (by tool_use_id),
 * SubagentStop, pane end or the sweep.
 *   pane end (pty exit: kill, reap/dehydrate, exit) -> warn/interrupted, all
 *   in flight > STALE_MS (one sweep timer per engine) -> warn/interrupted
 * Stop is main-thread only ON PURPOSE: a BACKGROUND sub-agent keeps calling
 * tools after the main turn's Stop, and ending its live call would paint a
 * running call "interrupted" and then drop its real end as an orphan.
 * An END WITH NO START is DROPPED: it only happens when the start never
 * reached this engine (restart mid-call, a lost hook), so no window holds that
 * id either -- the design system end() on an unknown id is a no-op anyway.
 * A second PreToolUse for an id already open is ignored (two hook entries).
 *
 * ENDS FIND THEIR START, NOT THE ROW THE SINK MATCHED (review 2026-09-25). The
 * sink resolves a hook to ONE live row by session_id; if two live rows bank the
 * same id (an adoption or picker-resume gap), a reorder of their updated_at
 * mid-call sends the end to the other pane. So an end resolves through a
 * tool_use_id -> paneid index (tool_use_ids are globally unique), the
 * session-level ends (Stop, idle_prompt, SessionEnd, StopFailure) reach the
 * main-thread calls THAT SESSION started, on whichever pane holds them, and an
 * agent's ends reach that agent_id's calls anywhere. A body with no session_id
 * (never from the sink) falls back to the matched pane.
 *
 * FLOOD BOUND (review 2026-09-25). The sink is unauthenticated on loopback, and
 * each start/end re-lays-out every chip the design system still holds (~12 s each), so an
 * unthrottled local caller could stall a session window for minutes while real
 * traffic never gets near it. So starts are admitted per pane from a token
 * bucket (START_BURST, refilled START_PER_S per second -- a real parallel burst
 * fits); an over-budget start records and emits NOTHING, and its later end is
 * then dropped by the no-start rule. At MAX_IN_FLIGHT the NEW start is ignored
 * the same way -- never an eviction, which would paint a real call
 * "interrupted" and orphan its true end. A drop is logged at most once per pane
 * per minute (with the count since the last line).
 *
 * FOLLOW-UP (not built; it changes the hook install, which is Owner's call):
 * AUTHENTICATE MCP hook events, so no other local user can paint at all. Two
 * shapes: (a) a per-pane hook secret minted into the spawned CLI's env beside
 * HARBOR_WB_PANEID (/proc/<pid>/environ is owner-only) and sent by the hook as
 * a header -- but the ssh launch path exports HARBOR_WB_* on the command line,
 * which /proc shows to everyone, so that path needs another channel; or (b)
 * accept the four tool events and SubagentStop only WITH the engine bearer
 * (the svc-ops hook can read secrets/engine.token, 0600), keeping the
 * loopback exemption for Notification/Stop/UserPromptSubmit alone.
 *
 * PRIVACY (hard rule): tool_input, tool_response, error and reason are never
 * read, stored, forwarded or logged. The one exception is the boolean
 * tool_response.isError. Frames carry the server and tool NAME only. Log
 * lines carry counts and paneids.
 *
 * Every entry point runs inside the hook sink, the pty exit handler or a
 * timer: nothing here may throw out, and the emitter is guarded.
 *
 * ---------------------------------------------------------------------------
 * PROPOSED HOOKS -- NOT INSTALLED (installing is Owner's call). Merged into
 * ~/.claude/settings.json `hooks` for server svc-ops, beside the existing
 * Notification/Stop/UserPromptSubmit entries (the existing Stop entry already
 * reaches the sink and needs no change). `jq` (1.7, /usr/bin/jq) strips the
 * body to ids + one boolean BEFORE it leaves the box, so no tool input or
 * output crosses the socket and a PostToolUse body stays tiny. The hook must
 * never block a tool: stdout/stderr discarded, `|| true` -> exit 0, 1 s cap.
 *
 *   CMD = jq -c '{session_id,hook_event_name,tool_name,tool_use_id,agent_id,agent_type,is_interrupt,tool_response:{isError:((.tool_response|objects|.isError)//null)}}' 2>/dev/null | curl -s -m 1 --connect-timeout 0.3 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:8201/api/claude-hook >/dev/null 2>&1 || true
 *
 *   "PreToolUse":         [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "PostToolUse":        [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "PostToolUseFailure": [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "PermissionDenied":   [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "SubagentStop":       [{ "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "StopFailure":        [{ "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }],
 *   "SessionEnd":         [{ "hooks": [{ "type": "command", "command": CMD, "timeout": 3 }] }]
 *
 * (idle_prompt needs nothing new: the installed Notification hook already
 * posts its whole body, notification_type included.)
 *
 * Each is a NEW entry in that event's array (the existing PreToolUse "Skill"
 * entry stays as it is). The VRPC posts through Serve with the server engine
 * bearer instead of loopback -- same CMD with the URL
 * https://server.example.ts.net:8444/api/claude-hook, adding
 * `--oauth2-bearer $(tr -d '[:space:]' < /f/code/briefing-table/secrets/homebase-engine.token)`
 * and `-m 2 --connect-timeout 0.5` for the tailnet hop (jq on the VRPC's Git
 * Bash is unverified; without it the filter must be done another way).
 * Synchronous on purpose (not `async: true`): Pre must land before Post, and
 * an async pair can race so the end arrives first and is dropped.
 * ========================================================================== */

import { mcpLabel } from './mcp-labels.ts';

export type McpResult = 'ok' | 'warn' | 'error';
export type McpWhy = 'isError' | 'failed' | 'denied' | 'interrupted';
export interface McpCaller {
  kind: 'agent' | 'sub';
  name: string;
}
/* A type alias, not an interface, so a frame is a plain Record for broadcast(). */
export type McpFrame = {
  type: 'pane.mcp';
  paneid: string;
  id: string;
  phase: 'start' | 'end';
  server: string;
  label: string;
  verb: string;
  caller: McpCaller;
  result?: McpResult;
  ms?: number;
  why?: McpWhy;
  ts: number;
};

export const MAX_IN_FLIGHT = 64;
export const READY_MAX = 8;
export const STALE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const ID_MAX = 200;
/* Real keys and tools are far shorter (the longest configured here is a
   25-char connector key); over either cap the hook is not an MCP call at all. */
const SERVER_MAX = 48;
const VERB_MAX = 64;
const TOOL_NAME_MAX = 'mcp__'.length + SERVER_MAX + 2 + VERB_MAX;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
/* WHAT A CHIP CAN BE MADE TO SAY. The sink is exempt from auth on loopback
   (auth.isLocalHookDelivery), and a live session_id is readable by any local
   user (claude's argv in /proc). So a local caller can paint SHORT MADE-UP
   WORDS: a server key <= 48 and a tool <= 64 chars of [A-Za-z0-9_-] (a key
   not in mcp-labels.ts's map, claude_ai_* included, is shown raw), a sub-agent name
   <= 32 of [A-Za-z0-9_:-] (no `.`, so never a host name). Escaped text, never
   markup; rate-limited per pane (admit()). That is NOT
   "never a sentence": `mcp__x__Your_login_expired` still reads as words. The
   closure is authenticating MCP hook events -- see FOLLOW-UP in the header.
   Claude Code's tool names fit the first alphabet (the API's tool-name
   alphabet); agent types fit the second (`Explore`, `plugin-name:agent`). */
const TOOL_NAME_RE = /^mcp__[A-Za-z0-9_-]+$/;
const AGENT_TYPE_RE = /^[A-Za-z0-9_:-]{1,32}$/;

export const START_BURST = 32;
export const START_PER_S = 4;
const DROP_LOG_MS = 60 * 1000;

interface Call {
  start: McpFrame;
  sid: string | null;
  agentId: string | null;
}
interface Limit {
  tokens: number;
  at: number;
  loggedAt: number;
  dropped: number;
}

/** paneid -> tool_use_id -> call. Insertion order is age (oldest first). */
const panes = new Map<string, Map<string, Call>>();
/** tool_use_id -> the paneid holding its start. Cleaned on every end. */
const owner = new Map<string, string>();
/** paneid -> its start bucket (FLOOD BOUND). Freed with the pane. */
const limits = new Map<string, Limit>();
let emitter: (frame: McpFrame) => void = () => {};
let log: (line: string) => void = () => {};

export function setEmitter(fn: (frame: McpFrame) => void): void {
  emitter = fn;
}
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

function emit(frame: McpFrame): void {
  try {
    emitter(frame);
  } catch {
    /* a dead socket must not break the sink or the exit path */
  }
}

/** `mcp__<server>__<tool>` -> {server, verb}, split at the FIRST `__` after the
 *  prefix (a server key may hold single `_` and `-`; a tool may hold `__`).
 *  service <= SERVER_MAX, tool <= VERB_MAX. Anything else -> null. */
export function parseToolName(name: unknown): { server: string; verb: string } | null {
  if (typeof name !== 'string' || name.length > TOOL_NAME_MAX || !TOOL_NAME_RE.test(name)) {
    return null;
  }
  const rest = name.slice('mcp__'.length);
  const cut = rest.indexOf('__');
  if (cut <= 0 || cut + 2 >= rest.length || cut > SERVER_MAX || rest.length - cut - 2 > VERB_MAX) {
    return null;
  }
  return { server: rest.slice(0, cut), verb: rest.slice(cut + 2) };
}

/** The sink's cheap pre-filter: a tool hook for a tool that is not MCP. The
 *  sink answers it before reading the table. */
export function isIgnorableToolHook(event: string, toolName: unknown): boolean {
  return TOOL_EVENTS.has(event) && !parseToolName(toolName);
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX ? v : null;
}

/** End a call on the pane that holds its start. False = no such start. */
function end(id: string, result: McpResult, why: McpWhy | null, now: number): boolean {
  const paneid = owner.get(id);
  const calls = paneid === undefined ? undefined : panes.get(paneid);
  const c = calls?.get(id);
  if (paneid === undefined || !calls || !c) {
    return false;
  }
  owner.delete(id);
  calls.delete(id);
  if (!calls.size) {
    panes.delete(paneid);
  }
  const s = c.start;
  emit({
    type: 'pane.mcp',
    paneid,
    id,
    phase: 'end',
    server: s.server,
    label: s.label,
    verb: s.verb,
    caller: s.caller,
    result,
    ms: Math.max(0, now - s.ts),
    ...(why ? { why } : {}),
    ts: now,
  });
  return true;
}

/** End every open call `pick` selects, on any pane, as warn/interrupted. */
function interrupt(pick: (paneid: string, c: Call) => boolean, reason: string, now: number): void {
  for (const [paneid, calls] of [...panes]) {
    let n = 0;
    for (const [id, c] of [...calls]) {
      if (pick(paneid, c) && end(id, 'warn', 'interrupted', now)) {
        n++;
      }
    }
    if (n) {
      log(`mcp: ${n} in-flight call(s) on ${paneid} ended interrupted (${reason})`);
    }
  }
}

/** The calls a session-level event may end: that session's, on whichever pane
 *  holds them; with no session id on either side, the matched pane's. */
function ofSession(paneid: string, sid: string | null): (p: string, c: Call) => boolean {
  return (p, c) => (sid !== null && c.sid !== null ? c.sid === sid : p === paneid);
}

/** FLOOD BOUND: spend one start from the pane's bucket. False = drop it
 *  silently (over budget, or MAX_IN_FLIGHT already open). */
function admit(paneid: string, open: number, now: number): boolean {
  let l = limits.get(paneid);
  if (!l) {
    l = { tokens: START_BURST, at: now, loggedAt: -Infinity, dropped: 0 };
    limits.set(paneid, l);
  }
  l.tokens = Math.min(START_BURST, l.tokens + (Math.max(0, now - l.at) / 1000) * START_PER_S);
  l.at = now;
  let why: string;
  if (l.tokens < 1) {
    why = `over ${START_BURST} then ${START_PER_S}/s`;
  } else if (open >= MAX_IN_FLIGHT) {
    why = `${MAX_IN_FLIGHT} already in flight`;
  } else {
    l.tokens -= 1;
    return true;
  }
  l.dropped++;
  if (now - l.loggedAt >= DROP_LOG_MS) {
    log(`mcp: ${paneid} dropped ${l.dropped} start(s) (${why}); logged at most once a minute`);
    l.loggedAt = now;
    l.dropped = 0;
  }
  return false;
}

function start(paneid: string, id: string, tool: { server: string; verb: string }, sid: string | null, b: Record<string, unknown>, now: number): void {
  const calls = panes.get(paneid) ?? new Map<string, Call>();
  if (owner.has(id) || !admit(paneid, calls.size, now)) {
    return;
  }
  panes.set(paneid, calls);
  owner.set(id, paneid);
  const agentId = idOf(b.agent_id);
  const type = typeof b.agent_type === 'string' && AGENT_TYPE_RE.test(b.agent_type) ? b.agent_type : '';
  const frame: McpFrame = {
    type: 'pane.mcp',
    paneid,
    id,
    phase: 'start',
    server: tool.server,
    label: mcpLabel(tool.server),
    verb: tool.verb,
    caller: agentId ? { kind: 'sub', name: type || 'subagent' } : { kind: 'agent', name: 'agent' },
    ts: now,
  };
  calls.set(id, { start: frame, sid, agentId });
  emit(frame);
}

/** One hook body for a pane the sink has already matched. Unknown events and
 *  non-MCP tools are ignored. */
export function onHook(paneid: string, b: Record<string, unknown>, now = Date.now()): void {
  const event = b.hook_event_name;
  const sid = idOf(b.session_id);
  const mine = ofSession(paneid, sid);
  const agentId = idOf(b.agent_id);
  if (event === 'SubagentStop' || (event === 'StopFailure' && agentId)) {
    if (agentId) {
      interrupt((_p, c) => c.agentId === agentId, event, now);
    }
    return;
  }
  const idle = event === 'Notification' && b.notification_type === 'idle_prompt';
  if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd' || idle) {
    interrupt((p, c) => mine(p, c) && c.agentId === null, idle ? 'idle_prompt' : event, now);
    return;
  }
  if (typeof event !== 'string' || !TOOL_EVENTS.has(event)) {
    return;
  }
  const tool = parseToolName(b.tool_name);
  const id = idOf(b.tool_use_id);
  if (!tool || !id) {
    return;
  }
  if (event === 'PreToolUse') {
    start(paneid, id, tool, sid, b, now);
  } else if (event === 'PostToolUse') {
    const r = b.tool_response;
    const isError = typeof r === 'object' && r !== null && (r as { isError?: unknown }).isError === true;
    end(id, isError ? 'error' : 'ok', isError ? 'isError' : null, now);
  } else if (event === 'PostToolUseFailure') {
    const interrupted = b.is_interrupt === true;
    end(id, interrupted ? 'warn' : 'error', interrupted ? 'interrupted' : 'failed', now);
  } else {
    end(id, 'warn', 'denied', now); // PermissionDenied
  }
}

/** The pane's process is gone: nothing it started can still report. */
export function endPane(paneid: string, now = Date.now()): void {
  interrupt((p) => p === paneid, 'pane ended', now);
  panes.delete(paneid);
  limits.delete(paneid);
}

/** The start frames still open on a pane, oldest first, at most READY_MAX. */
export function inFlight(paneid: string): McpFrame[] {
  const calls = panes.get(paneid);
  return calls ? [...calls.values()].slice(-READY_MAX).map((c) => c.start) : [];
}

/** The safety cap: a call open longer than STALE_MS is ended. */
export function sweep(now = Date.now()): void {
  interrupt((_p, c) => now - c.start.ts > STALE_MS, 'in flight over 30 min', now);
}

/** One timer per engine. Unref'd: it never holds a process open. */
export function startSweep(): () => void {
  const t = setInterval(() => {
    try {
      sweep();
    } catch {
      /* never out of a timer */
    }
  }, SWEEP_MS);
  t.unref();
  return () => clearInterval(t);
}
