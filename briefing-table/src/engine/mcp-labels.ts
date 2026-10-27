/* MCP SERVER DISPLAY NAMES for the session bar's MCP indicator (ticket,
 * mcp-calls.ts). Resolved ENGINE-side so every surface (solo, tabs, manager)
 * shows the same word for the same server; the renderer paints `label` and
 * never guesses one.
 *
 * Two rungs:
 *   1. a server we know by its settings key -> the name Owner calls it. This
 *      includes the claude.ai connectors in use (`claude_ai_<Name>`, the key
 *      Claude Code derives from "claude.ai <Name>");
 *   2. anything else -> the RAW key, as configured (`plugin_x_db`,
 *      `claude_ai_Some_New_Connector`).
 * NOTHING is humanised by rule (review 2026-09-25): the hook sink is
 * unauthenticated on loopback, and turning a made-up `Your_login_expired_x` --
 * or `claude_ai_Your_login_expired_x` -- into "Your Login Expired X" is what
 * makes it read like a sentence. A new connector gets a name by being added
 * here. */

const KNOWN = new Map<string, string>([
  ['fabric', 'Fabric'],
  ['claude_ai_Claude_Docs', 'Claude Docs'],
  ['claude_ai_Gmail', 'Gmail'],
  ['claude_ai_Google_Calendar', 'Google Calendar'],
  ['claude_ai_Google_Drive', 'Google Drive'],
]);

export function mcpLabel(server: string): string {
  return KNOWN.get(server) ?? server;
}
