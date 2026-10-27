/* ============================================================================
 * GET /api/sessions/readiness?paneids=a,b&room=<id>  (the design notes
 * §4.1) [ticket] — FAST FIELDS ONLY (S0; `detail=upgrade` is S2).
 *
 * Read-only: it aggregates state the engine already holds, for the Seat
 * modal's candidate list and the roster. Nothing here spawns, writes a config
 * or arms a watcher — `channel.possible` comes from the PURE planners
 * (channels.channelPossible → planLaunch / planVrpcLaunch), never from
 * prepareLaunch. `claudeRunning` reads the /proc classifier's 2 s cache; the
 * typed-delivery guard re-reads uncached before every write (§4.4 item 9).
 *
 * Omitting `paneids` = every live and dehydrated session (the modal's
 * candidate list, D1). `room` scopes `seat` (in-room, archived) to one room.
 * `seat.reason` is rooms.seatability — the same function assemble refuses by.
 * ========================================================================== */

import type { SessionRow } from '../table/endpoint.ts';
import { table } from '../table/endpoint.ts';
import type { Target } from '../engine/launch.ts';
import { hostOfTarget } from '../engine/launch.ts';
import * as activity from '../engine/activity.ts';
import * as channels from '../engine/channels.ts';
import * as roomTyper from '../engine/room-typer.ts';
import { seatability } from './rooms.ts';

export interface ReadinessDeps {
  /** index.ts's projectRow for this request (the /api/table decoration). */
  projector(): Promise<(row: any) => any>;
  /** The request carries a human credential (seatability's `needs-you`). */
  human: boolean;
  /** The target a pane's pty runs on (targets.json), if known. */
  targetOf(row: SessionRow): Target | undefined;
  /** Guard 9's question from the classifier's 2 s cache: true / false / null
   *  (could not tell — the pty is not on this host, or EACCES). */
  claudeOwnsTerminal(paneid: string): boolean | null;
}

/** `channel.reason` in the spec's words: the coordination's `off` is `channels-off`. */
const channelReason = (r: string | null): string | null => (r === 'off' ? 'channels-off' : r);

export async function readiness(
  q: { paneids: string[] | null; roomId: string | null },
  deps: ReadinessDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const room = q.roomId ? (table.getRoom(q.roomId) ?? null) : null;
  if (q.roomId && !room) {
    return { status: 404, body: { error: 'no such room', field: 'room' } };
  }
  const project = await deps.projector();
  const all = table.list();
  const unknown: string[] = [];
  let rows: SessionRow[];
  if (q.paneids === null) {
    rows = all.filter((r) => r.state === 'live' || r.state === 'dehydrated');
  } else {
    rows = [];
    for (const id of [...new Set(q.paneids)]) {
      const r = all.find((x) => x.paneid === id);
      if (r) rows.push(r);
      else unknown.push(id);
    }
  }
  const panes = rows.map((row) => {
    const p = project(row);
    const paneid = row.paneid;
    const live = row.state === 'live';
    const recipe = row.recipe_id ? table.getRecipe(row.recipe_id) : undefined;
    const target = deps.targetOf(row);
    const now = live ? channels.channelState(paneid) : false;
    const possible = target
      ? channels.channelPossible({ vendor: row.vendor, target, paneid, slug: row.agent })
      : { possible: false, reason: 'not-local' };
    const typed = roomTyper.queued(paneid);
    return {
      paneid,
      recipe_id: row.recipe_id,
      title: p.title ?? null,
      project: recipe?.name ?? row.friendlyName ?? null,
      vendor: p.vendor,
      host: target ? hostOfTarget(target) : null,
      state: row.state,
      attached: !!p.attached,
      delivery: !live ? null : now === true ? 'channel' : (row.vendor === 'claude-code' || row.vendor === 'codex-cli') && roomTyper.enabled() ? 'typed' : 'badge',
      draft: live ? activity.draftState(paneid) : 'unobserved',
      /* server only: the pane's pty must run on THIS host for /proc to see it —
         anywhere else is "could not tell", never "not running". */
      claudeRunning: live && row.vendor === 'claude-code' ? deps.claudeOwnsTerminal(paneid) : null,
      seats: table.roomsForPane(paneid).map(({ room: r, seat }) => ({ roomId: r.id, roomName: r.name, seatId: seat.id, handle: seat.handle })),
      seat: seatability(row, room, { human: deps.human }),
      activity: p.activity ?? null,
      dialogUp: activity.isDialogUp(paneid),
      queued: { typed: typed.typed, fabric: typed.fabric + channels.inFlightFor(paneid) },
      channel: { now, possible: possible.possible, reason: channelReason(possible.reason) },
    };
  });
  return { status: 200, body: { generatedAt: Date.now(), panes, unknown } };
}
