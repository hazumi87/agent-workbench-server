/**
 * `POST /api/agent-hook` — the vendor-neutral hook sink, first user: codex-cli
 * (Owner 2026-10-03, Codex vendor). The engine writes a hooks file for the pane
 * (codex-hooks.ts) whose commands post each hook's stdin JSON here with
 * `?vendor=codex-cli&paneid=<HARBOR_WB_PANEID>`.
 *
 * WHY BY PANE ID, NOT BY SESSION ID (the claude sink's key): a Codex session id
 * cannot be chosen at launch, so on a fresh pane the table does not have it yet
 * — the first hook is how it LEARNS it. The pane id is the engine's own, put in
 * the pane's environment at spawn, and the match is then CHECKED: the row must be
 * live and carry the vendor the query names (a hook for a pane that is not a
 * live codex-cli pane is a 200 no-op, never an error and never a side effect).
 *
 * WRITE-ONLY, NEVER LOGS CONTENT (auth.ts's exemption rests on this): it reads
 * ids and the event name, moves the pane's activity state, and may bank
 * `session_id`. Prompt text, tool input/output and the assistant's message are
 * never read into a log line — only counts, ids and field NAMES.
 *
 * ONE EXCEPTION, AND IT IS STORAGE NOT LOGGING (agent chat, Owner 2026-10-05):
 * the UserPromptSubmit prompt and the Stop's last assistant message go to the
 * pane's chat log (`deps.chat`), because a Codex transcript lives in another
 * account's home and these two payloads are the only conversation the engine
 * can see. The route is still write-only; READING that log needs a credential
 * (GET /api/sessions/:paneid/chat).
 *
 * Pure of the server: the table and the activity machine come in as `deps`, so a
 * test drives it with fixture payloads shaped exactly like the live ones.
 */

export const AGENT_HOOK_VENDORS = ['codex-cli'] as const;

export interface AgentHookDeps {
  get: (paneid: string) => { vendor?: string | null; state?: string; session_id?: string | null } | undefined;
  adoptSessionId: (paneid: string, sessionId: string) => void;
  activity: {
    onTurnStart: (paneid: string) => void;
    onResponseDone: (paneid: string) => void;
    onQuestion: (paneid: string) => void;
    /** Optional: a hook of any kind arrived for this pane (proof its hooks work). */
    noteHook?: (paneid: string) => void;
  };
  log: (line: string) => void;
  /** Agent chat: record a turn / note that a hook arrived without its text. Optional. */
  chat?: {
    record: (paneid: string, role: 'user' | 'agent', text: string) => void;
    gap: (paneid: string, event: string) => void;
  };
}

/** Field names a hook's turn text may arrive under, first hit wins. Codex's
 *  documented payloads use `prompt` and `last_assistant_message`; the others
 *  are guards (never confirmed against a captured 0.160 payload, so which one
 *  matched is logged, by NAME only). */
export const PROMPT_FIELDS = ['prompt', 'user_prompt', 'input'] as const;
export const REPLY_FIELDS = ['last_assistant_message', 'last_assistant_text', 'assistant_message', 'message'] as const;

function turnText(body: Record<string, unknown>, names: readonly string[]): { name: string; text: string } | null {
  for (const name of names) {
    const v = body[name];
    if (typeof v === 'string' && v.trim()) {
      return { name, text: v };
    }
  }
  return null;
}

export interface AgentHookResult {
  matched: string | null;
  /** What was done, for the 200 body and tests: ids and verbs only. */
  did: string[];
}

// Codex session ids are uuids today; accept any short token alphabet rather than
// pin the format, but never anything a log line or SQL parameter could surprise.
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const PANEID_RE = /^[A-Za-z0-9:_#.-]{1,128}$/;

function captureTurn(
  paneid: string,
  role: 'user' | 'agent',
  event: string,
  body: Record<string, unknown>,
  names: readonly string[],
  deps: AgentHookDeps,
  did: string[],
): void {
  if (!deps.chat) {
    return;
  }
  try {
    const hit = turnText(body, names);
    if (!hit) {
      deps.chat.gap(paneid, event);
      deps.log(`agent-hook ${paneid}: ${event} carried none of ${names.join('/')} (payload keys: ${Object.keys(body).slice(0, 20).join(',')})`);
      return;
    }
    deps.chat.record(paneid, role, hit.text);
    deps.log(`agent-hook ${paneid}: ${event} turn recorded from field '${hit.name}' (${hit.text.length} chars)`);
    did.push('chat');
  } catch {
    /* a chat log must never fail a hook */
  }
}

export function handleAgentHook(
  q: { vendor: string | null; paneid: string | null },
  body: Record<string, unknown>,
  deps: AgentHookDeps,
): AgentHookResult {
  const none: AgentHookResult = { matched: null, did: [] };
  if (!q.vendor || !(AGENT_HOOK_VENDORS as readonly string[]).includes(q.vendor)) {
    return none;
  }
  if (!q.paneid || !PANEID_RE.test(q.paneid)) {
    return none;
  }
  const row = deps.get(q.paneid);
  if (!row || row.vendor !== q.vendor || row.state !== 'live') {
    return none;
  }
  deps.activity.noteHook?.(q.paneid);
  const did: string[] = [];
  const sid = typeof body.session_id === 'string' && SESSION_ID_RE.test(body.session_id) ? body.session_id : null;
  if (sid && row.session_id !== sid) {
    deps.adoptSessionId(q.paneid, sid);
    deps.log(`agent-hook ${q.paneid}: ${q.vendor} session_id banked ${row.session_id ? `${row.session_id.slice(0, 8)} -> ` : ''}${sid.slice(0, 8)}`);
    did.push('session_id');
  }
  const event = typeof body.hook_event_name === 'string' ? body.hook_event_name : '';
  switch (event) {
    case 'UserPromptSubmit':
      deps.activity.onTurnStart(q.paneid);
      did.push('turn-start');
      captureTurn(q.paneid, 'user', event, body, PROMPT_FIELDS, deps, did);
      break;
    case 'Stop':
    case 'Interrupt':
      deps.activity.onResponseDone(q.paneid);
      did.push('response-done');
      if (event === 'Stop') {
        captureTurn(q.paneid, 'agent', event, body, REPLY_FIELDS, deps, did);
      }
      break;
    case 'PermissionRequest':
      deps.activity.onQuestion(q.paneid);
      did.push('question');
      break;
    default:
      // SessionStart / Pre|PostToolUse / SessionEnd: identity only. SessionEnd is
      // unreliable by Codex's own account — process exit is the authority.
      break;
  }
  return { matched: q.paneid, did };
}
