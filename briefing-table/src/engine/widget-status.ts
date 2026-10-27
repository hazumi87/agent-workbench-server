/**
 * WIDGET STATUS — a line a tool publishes about itself, rendered verbatim.
 *
 * WHY THE ENGINE LEARNS NOTHING: the first tool to need this is the local
 * command bridge, whose interesting state is a sudo credential. Teaching the
 * engine about sudo would break the blueprint seam — *core boots with zero
 * optional components; components register IN, core never reaches OUT* — and
 * would leave us with a bridge-shaped engine instead of a mechanism. So the
 * tool writes `{kind, text, ts}` to a path IT chooses, the recipe records that
 * path as DATA, and this module reads and caches it without interpreting the
 * text. `kind` is the only shared vocabulary and it is a closed set.
 *
 * See the design notes. This is the `status` verb of the (unbuilt)
 * script-widget class, landed early and alone because it was the cheapest way
 * to show the state WITHOUT violating the seam — not because the class is
 * being built ahead of its second subject.
 *
 * CACHED AND BACKGROUND-REFRESHED, never inline: reading it is an ssh round
 * trip and the manager polls /api/table every 2.5s. Exactly the session-titles
 * pattern — serve what is known immediately, refresh behind the request. A
 * stale status line is worth infinitely more than a manager that stalls.
 */
import { execFile } from 'node:child_process';
import { isWindows, sshBinary } from './platform.ts';

export interface WidgetStatus {
  kind: 'ok' | 'warn' | 'cold';
  text: string;
  /** When the TOOL wrote it (epoch seconds), not when we read it. */
  ts: number | null;
  /** How long ago we fetched, so a dead tool's line can be aged out by callers. */
  fetchedAt: number;
  /** Epoch seconds this state expires, or null. Passed through UNREAD — the
   *  engine never learns what is expiring, only that a deadline exists. The
   *  client ticks its own clock from this instead of us polling for a number
   *  it can compute perfectly by itself (Owner, 2026-09-03). */
  expiresAt: number | null;
}

interface Entry {
  value: WidgetStatus | null;
  fetchedAt: number;
  inFlight: boolean;
}

const cache = new Map<string, Entry>(); // key: `${sshAlias ?? 'local'}:${path}`
const TTL_MS = Number(process.env.HARBOR_WB_WIDGET_STATUS_TTL_MS ?? 15_000);
/** Older than this and the line is not shown at all — a tool that stopped
 *  publishing must go quiet rather than leave a frozen countdown on screen.
 *
 *  AGED ON THE TOOL'S `ts`, NOT ON OUR FETCH TIME. The first version compared
 *  `fetchedAt`, which is when the ENGINE last read the file — so a file that
 *  never changes is re-read every 15s and looks permanently fresh. Owner came
 *  back after two hours to a chip still reading "11h41m left" (2026-09-03).
 *  The comment above described the right intent; the code measured the wrong
 *  clock. Only the writer's timestamp can say whether anyone is still
 *  publishing. A tool that omits `ts` gets one grace window from first sight
 *  and then goes quiet, which is the safe direction. */
const MAX_AGE_MS = Number(process.env.HARBOR_WB_WIDGET_STATUS_MAX_AGE_MS ?? 120_000);

const KINDS = new Set(['ok', 'warn', 'cold']);

function key(path: string, sshAlias?: string): string {
  return `${sshAlias ?? 'local'}:${path}`;
}

/** What we know RIGHT NOW, with no I/O. Null when unknown or too stale. */
export function known(path: string | null | undefined, sshAlias?: string): WidgetStatus | null {
  if (!path) {
    return null;
  }
  const e = cache.get(key(path, sshAlias));
  if (!e?.value) {
    return null;
  }
  const v = e.value;
  /* The WRITER's clock decides. `fetchedAt` only says we could still read the
     file, which an abandoned file satisfies forever. */
  const wroteAt = v.ts ? v.ts * 1000 : v.fetchedAt;
  return Date.now() - wroteAt > MAX_AGE_MS ? null : v;
}

/* WHO WANTS TO KNOW A LINE CHANGED. The manager POLLS /api/table and needs no
 * such thing, but a session window is pushed to — and polling a cache to notice
 * it moved is both later and more code than being told. Stays generic: this
 * module still learns nothing about what any tool's line MEANS. */
let onChange: ((path: string, sshAlias: string | undefined) => void) | null = null;
/** What the CONSUMER can see. `fetchedAt` is deliberately excluded — it moves on
 *  every poll by definition, so including it makes every tick look like news
 *  and turns a change hook back into a timer. */
export function fingerprint(v: WidgetStatus | null): string {
  return v ? JSON.stringify([v.kind, v.text, v.ts, v.expiresAt]) : 'null';
}
export function setOnChange(cb: typeof onChange): void {
  onChange = cb;
}

/** Refresh if stale — fire-and-forget, never awaited by a request handler. */
export function refresh(path: string, sshAlias?: string): void {
  const k = key(path, sshAlias);
  let e = cache.get(k);
  if (!e) {
    e = { value: null, fetchedAt: 0, inFlight: false };
    cache.set(k, e);
  }
  if (e.inFlight || Date.now() - e.fetchedAt < TTL_MS) {
    return;
  }
  e.inFlight = true;

  /* `cat` on a path the RECIPE named. Not a shell: execFile with an argv, so a
     path with spaces or metacharacters cannot become a command. Remote reads go
     through the same ssh alias the recipe already launches with — no second
     identity, no new credential. */
  // sshBinary()/isWindows: the fifth ssh.exe site, folded in with Phase 1
  // (2026-09-15) — the READ runs on whichever host the engine itself runs on.
  const [bin, args] = sshAlias
    ? [sshBinary(), [sshAlias, 'cat', path]]
    : isWindows
      ? ['cmd', ['/c', 'type', path]]
      : ['cat', [path]];

  /* encoding:'buffer' + an explicit utf8 decode. DEFENSIVE, not a bug fix: the
     status line looked mangled ("sudo: warm ? 11h 41m left") when first checked,
     but that turned out to be the Windows console rendering the diagnostic
     output — the em-dash was intact in the payload all along. Being explicit
     still earns its place, since these lines are written by tools we do not
     control and a corrupted character would quietly erode trust in the whole
     indicator; it just never rescued anything. */
  const before = fingerprint(e.value);
  const announce = (): void => {
    /* Compared on VALUE, not on "a refresh happened" — this runs every TTL and
       a consumer rebuilding its UI on each tick would flicker for no new fact. */
    if (fingerprint(e!.value) !== before) {
      onChange?.(path, sshAlias);
    }
  };
  execFile(bin, args, { timeout: 8000, windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
    e!.inFlight = false;
    e!.fetchedAt = Date.now();
    if (err) {
      e!.value = null; // unreachable host, tool not running, file gone — all "no line"
      announce();
      return;
    }
    try {
      const o = JSON.parse(Buffer.from(stdout).toString('utf8').trim());
      const kind = KINDS.has(o?.kind) ? o.kind : 'warn';
      const text = typeof o?.text === 'string' ? o.text.slice(0, 120) : '';
      e!.value = text
        ? {
            kind,
            text,
            ts: Number(o?.ts) || null,
            expiresAt: Number(o?.expiresAt) || null,
            fetchedAt: Date.now(),
          }
        : null;
    } catch {
      /* A tool that publishes garbage says nothing, rather than putting its
         garbage on Owner's screen. */
      e!.value = null;
    }
    announce();
  });
}

/**
 * SELF-DRIVEN REFRESH — the indicator must not depend on being watched.
 *
 * refresh() was only ever called from inside the /api/table handler, so the
 * cache was warmed by VIEWERS: close the manager, or background the tab, and
 * nothing re-read the file. Come back and the line is as old as the last time
 * somebody happened to look, catching up only a poll or two later (Owner,
 * 2026-09-03: "it finally updated to 11:55, but it was a few minutes later").
 *
 * A status light whose freshness depends on someone already watching it is
 * exactly backwards — you look at it precisely because you have NOT been
 * watching. So the engine keeps it warm on its own clock, and a viewer only
 * ever reads what is already there.
 *
 * `supply` returns the paths worth polling — live sessions only, so a dead
 * project never costs an ssh round trip.
 */
export function startAutoRefresh(
  supply: () => Array<{ path: string; sshAlias?: string }>,
  /* 20s. When the tool publishes `expiresAt` the client renders the countdown
     on its own clock and this poll only has to catch STATE changes (a renew, an
     expiry, a tool quitting) — 60s would do. But a tool that publishes NO
     deadline falls back to its own text, and then this interval IS the refresh
     rate. Picking 60 optimises for the good case and quietly makes the fallback
     worse than before, so: 20s, which is unremarkable in both. */
  everyMs = Number(process.env.HARBOR_WB_WIDGET_STATUS_POLL_MS ?? 20_000),
): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      for (const { path, sshAlias } of supply()) {
        refresh(path, sshAlias); // TTL still gates the actual I/O
      }
    } catch {
      /* a bad supply must never kill the engine's timer */
    }
  }, everyMs);
  t.unref?.();
  return t;
}
