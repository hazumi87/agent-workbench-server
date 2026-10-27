// Pilot scope: Claude Code and Codex can join a room. Gemini, Ollama and Shell open as terminals, so a recipe for any of them is never
// offered as a room seat (Add a seat, New room, New workgroup) in the web build. One rule, one place; the words live here.
export const SEAT_VENDORS = Object.freeze(['claude-code', 'codex-cli']);
const web = () => !!(globalThis.wb && globalThis.wb.web);

export const WORDS = Object.freeze({
  rule: 'Claude Code and Codex can join a room. Gemini opens as a terminal.',
  noClaude: 'No Claude agent yet.',
  terminalOnly: "Opens as a terminal. It can't join a room.",
  programsLine: 'Opens as a terminal.',
  programsRoomLine: 'Opens in a room or as a terminal.',
});

/** The recipes that can sit in a room. The desktop's lists are untouched. */
export const seatRecipes = (list) => (Array.isArray(list) ? list : []).filter((rc) => !web() || (rc && SEAT_VENDORS.includes(rc.vendor)));

/** The program a recipe runs, in the name a person uses. */
export const programName = (rc) => ({ 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', ollama: 'Ollama', 'cli-manager': 'Shell' }[rc && rc.vendor] || (rc && rc.name) || 'That program');

/** The refusal when something still tries to put a non-Claude program in a room (an old seat, a stale page); null when it may. */
export const refusal = (rc) => (web() && rc && !SEAT_VENDORS.includes(rc.vendor) ? programName(rc) + " can't join a room yet. Open it from Terminals instead." : null);

/** Does the web build apply the rule at all? */
export const applies = web;
