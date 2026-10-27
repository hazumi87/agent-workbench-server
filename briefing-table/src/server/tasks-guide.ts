/* THE TASKS SECTION OF THE ROOM GUIDE. The text is KB design-notes-id section 13 (FINAL, builder-two), verbatim; only {ROOM_ID} is filled in. It is shown only
 * when Tasks is on AND this is a local engine that has bound a port: those are the panes that have HARBOR_WB_ENGINE_URL (launch.ts), so the curl lines are right for
 * them and would be wrong for any other pane (another host, ssh, a server engine). Written by a script from JSON so every quote and backslash is exact. */
import { tasksEnabled } from './tasks-routes.ts';
import { isLocalMode } from '../engine/local-mode.ts';
import { enginePort } from '../engine/local-guard.ts';

export const TASKS_GUIDE: string = "TASKS: this room's task list, kept on this PC. The person sees it as the Tasks card in the rail.\nUse these verbs for room tasks. Don't keep a task list anywhere else, and don't use another task system for this room.\n\nHow to call (the same verb names move to agent room tools later):\n  TOKEN=\"${HARBOR_WB_PANE_TOKEN:-$(cat \"$HARBOR_WB_PANE_TOKEN_FILE\")}\"\n  T=\"$HARBOR_WB_ENGINE_URL/api/rooms/{ROOM_ID}/tasks\"\n  curl -sS -H \"authorization: Bearer $TOKEN\" \"$T?status=open&limit=50\"\n  curl -sS -H \"authorization: Bearer $TOKEN\" -H 'content-type: application/json' \\\n       -d '{\"title\":\"Wire the cells\",\"priority\":2}' \"$T\"\nNever print the token, put it on a shared command line, or paste it into the room.\n\nRead:       GET $T (?group ?status ?limit, at most 200) · GET $T/summary · GET $T/timeline (?group ?hours, 1-24)\nAny seat:   add: POST $T {title, body?, group?, priority 0-5?, parent?}\n            claim / unclaim: POST / DELETE $T/<tid>/claim\n            status: POST $T/<tid>/status {status: open|in-progress|blocked|done}, on a task you claimed\n            flag / unflag: POST / DELETE $T/<tid>/flag, which marks any task in this room's family as needing the person\n            priority: POST $T/<tid>/priority {priority} · subtasks: POST $T/<tid>/subtasks {titles} · bug / unbug\n            ask-lead: POST $T/ask-lead {group?, text}, which sends one line to that group's lead\nGroup lead: progress: POST $T/<tid>/progress {pct, note}, the % the person sees, with a one-line note\n            assign: POST $T/<tid>/assign {group} or {seat} · pin / unpin · topics · focus: PUT $T/focus\n            link / unlink: POST / DELETE $T/link, which puts your own group on or off the room plan\nOnly the person: deleting a task, and linking another group. Ask them if one of these is needed.\n\nHow to work:\n- Claim before you start. Set in-progress when you begin and done when you finish; the timeline is built from these changes.\n- Leads set % at real milestones, with a note a person can read.\n- Flag only when the person must act. A task waiting on another group is \"blocked\", not flagged.\n- After a change that matters, say it on the room line in one line: added \"Wire the cells\" (open) · #12 to done.\n- Limits: at most 20 writes a minute, shared with your room posts. A title is up to 200 characters, a note up to 280, a body up to 16 KB.\n\nErrors:\n- {\"error\": \"<sentence>\", \"field\": \"<name>\"}: 400 for a bad input (the field says which), 403 when it isn't yours to change (owner or lead only), 404 for no such task, group or seat here, 409 for a conflict (a claim held, no lead yet, too many open tasks).\n- {\"ok\": false, \"error\": \"<code>\", \"message\": \"...\"}:\n  - 401: no token, or a bad one.\n  - 403 not_for_pane_token: that action is the person's.\n  - 403 not_seated: you have no seat in that room.\n  - 429 rate_limited: wait `retry_after` seconds.\n- On any 403, say so on the room line and stop. Don't look for another way around it.\n";

/** The section for this room, or null when this engine's panes could not use it. */
export function tasksGuide(roomId: string): string | null {
  if (!tasksEnabled() || !isLocalMode(process.env) || enginePort() <= 0) {
    return null;
  }
  return TASKS_GUIDE.split('{ROOM_ID}').join(roomId);
}

/** POSTING AND READING WITHOUT ROOM TOOLS (local engine). A pane that has no `bt` tools (a vendor with no carrier yet, or a bt that did not connect) answers the room with
 *  the same HTTP door the tools use, on its pane token. Shown on the same terms as Tasks: a local engine that has bound a port, because only those panes have
 *  HARBOR_WB_ENGINE_URL. */
export const POST_GUIDE: string = [
  'POST AND READ, when you have no room_post tool (the same door the tools use):',
  '  TOKEN="${HARBOR_WB_PANE_TOKEN:-$(cat "$HARBOR_WB_PANE_TOKEN_FILE")}"',
  '  L="$HARBOR_WB_ENGINE_URL/api/rooms/{ROOM_ID}/line"',
  '  curl -sS -H "authorization: Bearer $TOKEN" -H \'content-type: application/json\' -d \'{"text":"@user done: what you did"}\' "$L"',
  '  curl -sS -H "authorization: Bearer $TOKEN" "$L?for=me&limit=20"',
  'The first posts a line AS YOUR SEAT (start with @handle to address a seat, @user to reach the person); the second reads the lines addressed to you.',
  'Never print the token or put it on a shared command line. At most 20 posts a minute. A reply only in your terminal is not seen.',
  '',
].join('\n');

export function postGuide(roomId: string): string | null {
  if (!isLocalMode(process.env) || enginePort() <= 0) {
    return null;
  }
  return POST_GUIDE.split('{ROOM_ID}').join(roomId);
}
