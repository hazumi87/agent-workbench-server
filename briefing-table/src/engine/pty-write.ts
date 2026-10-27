/* THE ONE FUNNEL FOR PTY INPUT (security review R1/T1, W1). Every byte that reaches a pane's terminal goes through here with an ORIGIN, so a proof can show which bytes came from a person's keystrokes and which the
 * engine typed, and that message delivery typed no peer text. There are exactly these origins:
 *   person           the signed-in person's own keystrokes from a window (the websocket `input` command)
 *   room-typer       a room line / doorbell / digest the typer sends, and its Enter
 *   launch           the launch line typed into a shell (never in the hosted profile: it direct-spawns)
 *   dialog           the channel-dialog Enter (never in the hosted profile)
 *   voice            the voice actor's line (off in the hosted profile)
 * A bounded ring records each write (time, pane, origin, byte count, sha256) and, ONLY when HARBOR_WB_PTY_TRACE_TEXT=1 (a test engine), the text itself. GET /api/diag/pty-writes (person only) reads it.
 * No behaviour changes here: engineWrite is pty.write plus the record. */
import { createHash } from 'node:crypto';

export type WriteOrigin = 'person' | 'room-typer' | 'launch' | 'dialog' | 'voice';

export interface WriteRecord {
  at: number;
  paneid: string;
  origin: WriteOrigin;
  bytes: number;
  sha256: string;
  text?: string;
}

const MAX = 2000;
const ring: WriteRecord[] = [];

const traceText = (): boolean => process.env.HARBOR_WB_PTY_TRACE_TEXT === '1';

export function engineWrite(paneid: string, pty: { write(data: string): void }, data: string, origin: WriteOrigin): void {
  const rec: WriteRecord = { at: Date.now(), paneid, origin, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') };
  if (traceText()) rec.text = data;
  ring.push(rec);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  pty.write(data);
}

export function writes(filter: { paneid?: string; origin?: WriteOrigin; since?: number } = {}): WriteRecord[] {
  return ring.filter((r) => (!filter.paneid || r.paneid === filter.paneid) && (!filter.origin || r.origin === filter.origin) && (filter.since === undefined || r.at >= filter.since));
}

export function resetTrace(): void {
  ring.length = 0;
}
