/* THE bt TOOL PROFILES (design review [ref]): the engine's own per-token limit on which bt tools a pane token may list and call. The authority for what an agent can do through
 * `bt` is HERE, in the engine, never in a client's approval setting (Codex 0.160.1 has no per-MCP-tool approval request, and Claude's --allowedTools is only a prompt-avoider).
 * A profile is chosen at MINT and stored with the token; /mcp lists only its tools and refuses the rest with an isError, whatever the client sent.
 *
 * THE RULE FOR ADDING A TOOL (replaces the old "never blanket" comment): a tool that WRITES anything beyond a room line as the seat (a Tasks write verb, a file, a setting)
 * must NOT join any profile until it answers {status:'confirm', prompt, confirm:<token>} and raises a room approval; the person approves in the room and the agent
 * re-calls with the single-use confirm token bound to the pane, the tool and the exact arguments (the pattern room_post already uses for room commands). Until then it
 * is not a bt tool. The five below read the seat's own rooms or post one line as the seat, all bounded by the same section-4.1 allow-list as the HTTP door.
 * NOTE: a profile gates /mcp only. The same token also opens the HTTP agent door; a future write verb must be refused THERE too for a token without it. */
export const READ_TOOLS: readonly string[] = ['handbook', 'room_list_mine', 'room_read', 'room_roster', 'session_whoami'];
export const ALL_TOOLS: readonly string[] = ['handbook', 'room_list_mine', 'room_read', 'room_post', 'room_roster', 'session_whoami'];

export const PROFILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /** read the seat's rooms and post a line as the seat: every pane token today */
  default: ALL_TOOLS,
  /** read only (no room_post): for a token that must never speak */
  read: READ_TOOLS,
});

export const DEFAULT_PROFILE = 'default';
export const isProfile = (p: unknown): p is string => typeof p === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, p);
/** The tools of a profile; an unknown (or missing) name gets the SMALLEST profile, never the largest. */
export const toolsOf = (p: unknown): readonly string[] => (isProfile(p) ? PROFILES[p] : READ_TOOLS);
