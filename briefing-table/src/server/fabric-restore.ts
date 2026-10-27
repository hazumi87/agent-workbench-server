/* ============================================================================
 * POST /api/fabric/restore {slug, envelope_id?} — bring a disconnected agent
 * back NOW, for a message the sender chose to deliver that way (ticket, Owner
 * 2026-09-30, KB design-notes-id part 4).
 *
 * THE CALLER IS THE FABRIC. A send to a session agent that is not live answers
 * 409 not-live unless the sender picked `delivery:'hold'` (leave a message) or
 * `delivery:'restore'`. For `restore` the fabric has STORED (not emitted) the
 * envelope and calls this route; it emits after `{ok:true}`, and on anything
 * else drops the envelope and tells the sender "message not sent". So the one
 * hard rule here is Owner's: A FAILED RESTORE IS NEVER SILENT. Every outcome is
 * a named reason, and one log line per call says which.
 *
 * NO NEW SPAWN PATH. The restore is the room seat's rehydrate: the launch
 * route's own function (launchRecipe) with `target:'tab', surface:'browser'`
 * so no window opens, then an attach on the engine's OWN /pty socket — the
 * exact attach a window sends, so every guard the spawn path carries (guard 7,
 * locate-refresh, the startup gate, prompt-block, pane tokens, channels) runs
 * unchanged. The socket attaches `intent:'view'` (it never takes the keyboard)
 * and is closed before the answer, leaving the session PARKED — alive in the
 * broker with no window, exactly like a seat whose window was closed.
 *
 * THE WAIT, bounded (HARBOR_WB_FABRIC_RESTORE_WAIT_MS, default 80 s — under the
 * fabric's own 90 s FABRIC_RESTORE_TIMEOUT_MS so our answer always lands):
 *   exited            the pty ended (pane.exit)
 *   session-not-found claude printed "No conversation found with session ID:"
 *                     (CC 2.1.286 binary, `GS=` constant) BEFORE its banner.
 *                     The pane is then ended back to `dehydrated` — the state
 *                     it was in — so no bare shell is left answering to a slug
 *   needs-you         a prompt only a human answers: prompt-block's login /
 *                     permission / question, or a startup prompt the engine
 *                     does not answer (trust, old-session, …). The pane is LEFT
 *                     ALIVE for the human.
 *   ok                past startup: the startup gate reports the REPL
 *   timeout           none of the above in time; the pane is left as it is
 * plus the refusals before any spawn: no-session, not-resumable, restore-cap,
 * refused (guard 7: another claude is writing that conversation), spawn-failed.
 *
 * ONE RESTORE PER SLUG AT A TIME (a concurrent call joins the in-flight one)
 * and AT MOST 3 PER SLUG PER ROLLING HOUR — the start of the ping-pong guard
 * (ticket): two agents restoring each other forever is the failure it stops.
 *
 * NEVER LOGS MESSAGE CONTENT — there is none here: slug, envelope id, outcome.
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';

export type RestoreReason =
  | 'no-session'
  | 'not-resumable'
  | 'restore-cap'
  | 'refused'
  | 'spawn-failed'
  | 'exited'
  | 'session-not-found'
  | 'needs-you'
  | 'timeout';

export type RestoreAnswer =
  | { ok: true; paneid: string; already?: true }
  | { ok: false; reason: RestoreReason; detail?: string; paneid?: string };

export interface RestoreRow {
  paneid: string;
  recipe_id: string | null;
  vendor: string;
  state: string;
}

export interface RestoreDeps {
  /** The most recent session row for this slug (agent slug, or the work slug
   *  check-in last handed it), or undefined. */
  rowForSlug(slug: string): RestoreRow | undefined;
  /** Is this vendor one whose conversation comes back (and whose startup the
   *  engine can watch)? */
  resumable(vendor: string): boolean;
  recipeExists(recipeId: string): boolean;
  /** The room seat's launch (launchRecipe). Throws {status, message} on a refusal. */
  launch(recipeId: string, body: Record<string, unknown>): Promise<{ paneid: string }>;
  /** ws://…/pty on this engine, and the credential its gate accepts. */
  socketUrl(): string;
  socketToken(): string;
  isLive(paneid: string): boolean;
  /** A prompt only a human answers, by kind, or null. */
  needsYou(paneid: string): string | null;
  /** Past startup: the startup gate is armed for this pane and not blocking. */
  ready(paneid: string): boolean;
  /** End a live pane back to `dehydrated` (endForCycle). */
  endBack(paneid: string): Promise<unknown>;
  log(line: string): void;
}

const CAP = 3;
const CAP_WINDOW_MS = 60 * 60 * 1000;
const POLL_MS = 150;

function waitMs(): number {
  const v = Number(process.env.HARBOR_WB_FABRIC_RESTORE_WAIT_MS);
  return process.env.HARBOR_WB_FABRIC_RESTORE_WAIT_MS && Number.isFinite(v) && v > 0 ? v : 80_000;
}

/* ---- claude's own words, read from the installed binary (read-only) ------
 * CC 2.1.286: `var GS="No conversation found with session ID:"` and
 * `` `No conversation found with session ID: ${H}` `` on the explicit-id
 * resume path (`failure_reason:"not_found_explicit_id"`), printed before the
 * REPL mounts, then exit(1). "No conversation found to continue" is the
 * --continue twin. Matched on the normalised stream (escapes → space). */
const NOT_FOUND = /No conversation found (?:with session ID:|to continue)/;
/* The REPL's banner / footer. A not-found line AFTER it is conversation text
   being re-rendered (an agent that once discussed this very error), not the
   resume failing: ignored, and the wait carries on. */
const REPL_DRAWN = /Claude Code ?v ?\d+\.\d+\.\d+|\? for shortcuts|(?:auto mode|accept edits|plan mode|bypass permissions|manual mode) on(?![a-z])/;
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
function normalise(s: string): string {
  return s.replace(ESC_SEQ, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ');
}

/** Scan a restore's output for the not-found line, in stream order. */
export class ResumeWatch {
  private tail = '';
  replDrawn = false;
  notFound = false;
  feed(chunk: string): void {
    if (this.notFound || this.replDrawn) {
      return; // decided: either it failed, or the REPL is up and later text is conversation
    }
    const buf = this.tail + normalise(chunk);
    const nf = NOT_FOUND.exec(buf);
    const rd = REPL_DRAWN.exec(buf);
    if (nf && (!rd || nf.index < rd.index)) {
      this.notFound = true;
    } else if (rd) {
      this.replDrawn = true;
    }
    this.tail = buf.slice(-200);
  }
}

/* ---- in flight + the cap ---------------------------------------------------- */

const inFlight = new Map<string, Promise<RestoreAnswer>>();
const starts = new Map<string, number[]>();

function underCap(slug: string, now: number): boolean {
  const recent = (starts.get(slug) ?? []).filter((t) => now - t < CAP_WINDOW_MS);
  starts.set(slug, recent);
  return recent.length < CAP;
}

/** Tests only. */
export function reset(): void {
  inFlight.clear();
  starts.clear();
}

/**
 * Restore the agent behind `slug`. `envelopeId` is only logged. Never throws:
 * every failure is an answer.
 */
export async function restore(slug: string, envelopeId: string | null, deps: RestoreDeps): Promise<RestoreAnswer> {
  const t0 = Date.now();
  const tag = `fabric restore ${slug}${envelopeId ? ` (envelope ${envelopeId})` : ''}`;
  const say = (a: RestoreAnswer, how = ''): RestoreAnswer => {
    const what = a.ok ? (a.already ? `ok already live ${a.paneid}` : `ok ${a.paneid}`) : `FAILED ${a.reason}${a.detail ? ` (${a.detail})` : ''}${a.paneid ? ` ${a.paneid}` : ''}`;
    deps.log(`${tag}: ${how}${what} in ${Date.now() - t0}ms`);
    return a;
  };
  const joined = inFlight.get(slug);
  if (joined) {
    return say(await joined, 'joined the in-flight restore: ');
  }
  let row: RestoreRow | undefined;
  try {
    row = deps.rowForSlug(slug);
  } catch (e) {
    return say({ ok: false, reason: 'no-session', detail: `table read failed: ${(e as Error).message}` });
  }
  if (!row) {
    return say({ ok: false, reason: 'no-session' });
  }
  if (row.state === 'live' && deps.isLive(row.paneid)) {
    return say({ ok: true, paneid: row.paneid, already: true });
  }
  if (row.vendor !== 'claude-code' || !deps.resumable(row.vendor)) {
    return say({ ok: false, reason: 'not-resumable', detail: `vendor ${row.vendor || 'unknown'}`, paneid: row.paneid });
  }
  if (row.state !== 'dehydrated') {
    /* `killed` = the user ended it and it never auto-resumes (end-state.ts);
       `corrupted` is never resumed (Seam C2). A restore by another agent is
       not the user deciding otherwise. */
    return say({ ok: false, reason: 'not-resumable', detail: `state ${row.state}`, paneid: row.paneid });
  }
  const rid = row.recipe_id;
  if (!rid || !deps.recipeExists(rid) || !(row.paneid === `recipe:${rid}` || row.paneid.startsWith(`recipe:${rid}#`))) {
    return say({ ok: false, reason: 'not-resumable', detail: 'no project to launch it from', paneid: row.paneid });
  }
  if (!underCap(slug, t0)) {
    return say({ ok: false, reason: 'restore-cap', detail: `${CAP} restores in the last hour`, paneid: row.paneid });
  }
  starts.get(slug)!.push(t0);
  const run = runRestore(row.paneid, rid, deps);
  inFlight.set(slug, run);
  try {
    return say(await run);
  } finally {
    inFlight.delete(slug);
  }
}

async function runRestore(paneid: string, recipeId: string, deps: RestoreDeps): Promise<RestoreAnswer> {
  const deadline = Date.now() + waitMs();
  try {
    await deps.launch(recipeId, {
      target: 'tab',
      surface: 'browser', // a url, never a window (launchRecipe's browser-tab branch)
      ...(paneid !== `recipe:${recipeId}` ? { pane: paneid } : {}),
    });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return err.status === 409
      ? { ok: false, reason: 'refused', detail: err.message ?? 'refused', paneid }
      : { ok: false, reason: 'spawn-failed', detail: err.message ?? String(e), paneid };
  }
  const watch = new ResumeWatch();
  let exited: string | null = null;
  let readyMsg: Record<string, unknown> | null = null;
  let socketGone: string | null = null;
  const ws = new WebSocket(deps.socketUrl(), { headers: { authorization: `Bearer ${deps.socketToken()}` } });
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
    if (m.type === 'pane.data' && typeof m.data === 'string') {
      watch.feed(m.data);
    } else if (m.type === 'pane.exit') {
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
    ws.send(JSON.stringify({ type: 'attach', paneid, recipe: recipeId, intent: 'view', label: 'fabric restore' }));
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    /* 1. the spawn: pane.ready, or the attach's own refusal. */
    for (;;) {
      const r = readyMsg as Record<string, unknown> | null;
      if (r) {
        if (r.type === 'pane.ready') {
          break;
        }
        return { ok: false, reason: 'spawn-failed', detail: String(r.message ?? r.type), paneid };
      }
      if (socketGone) {
        return { ok: false, reason: 'spawn-failed', detail: socketGone, paneid };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'timeout', detail: 'no spawn answer', paneid };
      }
      await sleep(POLL_MS / 3);
    }
    /* 2. past startup, or why not. */
    for (;;) {
      if (exited || !deps.isLive(paneid)) {
        return { ok: false, reason: 'exited', detail: exited ?? 'the session ended', paneid };
      }
      if (watch.notFound) {
        try {
          await deps.endBack(paneid);
        } catch {
          /* ending it is tidy-up; the answer stands either way */
        }
        return { ok: false, reason: 'session-not-found', paneid };
      }
      const blocked = deps.needsYou(paneid);
      if (blocked) {
        return { ok: false, reason: 'needs-you', detail: blocked, paneid };
      }
      if (deps.ready(paneid)) {
        return { ok: true, paneid };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'timeout', paneid };
      }
      await sleep(POLL_MS);
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}

/* ---- the restore-scoped token -----------------------------------------------
 * The fabric runs as unix user `service`; the engine bearer never goes to it.
 * So this route ALSO takes a token read from HARBOR_WB_FABRIC_RESTORE_TOKEN_FILE,
 * valid for THIS route only (any other route presenting it is 401). Unset env,
 * a missing or empty file: no restore token exists. Read per request (a few
 * bytes) so a provisioned or rotated file needs no restart; never minted or
 * written here — Owner provisions it. */

function restoreToken(engineBearer: string): string | null {
  const file = process.env.HARBOR_WB_FABRIC_RESTORE_TOKEN_FILE;
  if (!file) {
    return null;
  }
  let t: string;
  try {
    t = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  /* A file holding the engine bearer itself would turn the bearer into a
     one-route token. Refuse that reading rather than lock the engine out. */
  return t && t !== engineBearer ? t : null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when the request presents the restore-scoped token. */
export function presentsRestoreToken(req: IncomingMessage, engineBearer: string): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) {
    return false;
  }
  const presented = h.slice(7).trim();
  if (!process.env.HARBOR_WB_FABRIC_RESTORE_TOKEN_FILE || presented === engineBearer) {
    return false; // the common case (the engine bearer) never touches the disk
  }
  const want = restoreToken(engineBearer);
  return !!want && same(presented, want);
}
