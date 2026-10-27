/* ============================================================================
 * SEAT RELOAD — drive a headless FRESH launch to startup-ready (ticket).
 *
 * The seat reload's default placement (no window requested) is the same
 * headless shape fabric-restore.ts uses: `launchRecipe` with
 * `{target:'tab', surface:'browser'}` returns a paneid + url but opens
 * nothing — "the window is the viewer; the spawn happens when it attaches"
 * (src/server/index.ts launchRecipe). Nobody is going to attach a real
 * window, so THIS module is the viewer: it opens the engine's own /pty
 * socket, sends the attach, and waits for the startup gate to clear, then
 * closes the socket — leaving the session exactly as parked as a Restore
 * with no window open.
 *
 * Deliberately NOT fabric-restore's runRestore: this is a FRESH launch (no
 * `--resume`), so there is no "No conversation found" text to watch for and
 * no restore cap/in-flight-join bookkeeping (the seat route's own "one
 * reload per pane" guard covers that). Kept as its own small module so
 * fabric-restore.ts — frozen, already covered by its own suite — needs no
 * change for a second caller of the same attach shape.
 * ========================================================================== */

import { WebSocket } from 'ws';

export type DriveReason = 'spawn-failed' | 'exited' | 'needs-you' | 'timeout';
export type DriveAnswer = { ok: true } | { ok: false; reason: DriveReason; detail?: string };

export interface DriveDeps {
  /** ws://…/pty on this engine, and the bearer its gate accepts. */
  socketUrl(): string;
  socketToken(): string;
  /** A prompt only a human answers, by kind, or null. */
  needsYou(paneid: string): string | null;
  /** Past startup: the startup gate is armed for this pane and not blocking. */
  ready(paneid: string): boolean;
  log(line: string): void;
  /** [assistant switch] attach IN-PROCESS instead of dialling the socket (self-viewer.ts): the engine's own dial
   *  carries the shared bearer, which strict accounts refuse. Absent = the socket, as before. */
  open?(): { on(event: string, fn: (...args: any[]) => void): unknown; send(data: string): void; close(): void };
  /** Return as soon as the pty has SPAWNED (pane.ready), without waiting for startup to settle: the local-mode Start only has to
   *  create the pane so the app's /term (reattach-only) can join it. The socket is still closed, leaving the pane parked. */
  spawnOnly?: boolean;
}

function waitMs(): number {
  const v = Number(process.env.HARBOR_WB_SEAT_RELOAD_WAIT_MS);
  return process.env.HARBOR_WB_SEAT_RELOAD_WAIT_MS && Number.isFinite(v) && v > 0 ? v : 60_000;
}

/**
 * Attach to `paneid` (already launched headless by the caller) with
 * `intent:'view'` — never takes the keyboard — and wait until the startup
 * gate says it is past startup, a human-only prompt is up, the pty exits, or
 * the bounded wait runs out. The socket is always closed before returning,
 * leaving the pane parked (alive in the broker, no window).
 */
export async function driveToReady(paneid: string, recipeId: string, deps: DriveDeps): Promise<DriveAnswer> {
  const deadline = Date.now() + waitMs();
  let exited: string | null = null;
  let readyMsg: Record<string, unknown> | null = null;
  let socketGone: string | null = null;
  const ws = deps.open ? deps.open() : new WebSocket(deps.socketUrl(), { headers: { authorization: `Bearer ${deps.socketToken()}` } });
  ws.on('message', (raw) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.paneid !== paneid) {
      return;
    }
    if (m.type === 'pane.exit') {
      exited = `exit code ${m.code ?? 'unknown'}`;
    } else if (m.type === 'pane.ready' || m.type === 'pane.error' || m.type === 'pane.needs-launch') {
      readyMsg ??= m;
    }
  });
  ws.on('error', (e) => {
    socketGone ??= e.message;
  });
  ws.on('close', (code) => {
    socketGone ??= `socket closed (${code})`;
  });
  ws.on('unexpected-response', (_req, res) => {
    socketGone ??= `the engine refused its own socket (${res.statusCode})`;
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'attach', paneid, recipe: recipeId, intent: 'view', label: 'seat reload' }));
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    for (;;) {
      const r = readyMsg as Record<string, unknown> | null;
      if (r) {
        if (r.type === 'pane.ready') {
          break;
        }
        return { ok: false, reason: 'spawn-failed', detail: String(r.message ?? r.type) };
      }
      if (socketGone) {
        return { ok: false, reason: 'spawn-failed', detail: socketGone };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'timeout', detail: 'no spawn answer' };
      }
      await sleep(50);
    }
    if (deps.spawnOnly) {
      return { ok: true };
    }
    for (;;) {
      if (exited) {
        return { ok: false, reason: 'exited', detail: exited };
      }
      const blocked = deps.needsYou(paneid);
      if (blocked) {
        return { ok: false, reason: 'needs-you', detail: blocked };
      }
      if (deps.ready(paneid)) {
        return { ok: true };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'timeout' };
      }
      await sleep(150);
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}
