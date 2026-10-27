/* E1 "NO ROOM TOOLS" STATE: does a pane that was launched with the bt tools actually have them? THREE OUTCOMES, never two (CLAUDE.md cross-cutting trap):
 *   room     the pane's token has made an /mcp call (initialize or tools/list or a tool) in this process's life;
 *   none     injection was planned, the pane has been live longer than TOOLS_SECS, and no call ever came (a reason rides along);
 *   unknown  nothing was planned (ssh, another host, a vendor with no carrier yet), or the pane is too young to tell.
 * Memory only, keyed by paneid: a restart of the engine forgets it (an adopted pane re-announces itself on its next /mcp call; until then it reads unknown). */
export const TOOLS_SECS = Number(process.env.HARBOR_WB_TOOLS_SECS) > 0 ? Number(process.env.HARBOR_WB_TOOLS_SECS) : 30;

interface Rec {
  plannedAt: number | null;
  calledAt: number | null;
  why: string | null;
  said: boolean;
  listed: { generation: number; at: number } | null;
}
const panes = new Map<string, Rec>();
const rec = (paneid: string): Rec => {
  let r = panes.get(paneid);
  if (!r) {
    r = { plannedAt: null, calledAt: null, why: null, said: false, listed: null };
    panes.set(paneid, r);
  }
  return r;
};

export function _reset(): void {
  panes.clear();
}
export function plan(paneid: string, now = Date.now()): void {
  const r = rec(paneid);
  r.plannedAt = now;
  r.calledAt = null;
  r.why = null;
  r.said = false;
  r.listed = null;
}
export function notPlanned(paneid: string, why: string): void {
  const r = rec(paneid);
  r.plannedAt = null;
  r.listed = null;
  r.why = why;
}
export function noteCall(paneid: string, now = Date.now()): void {
  const r = panes.get(paneid);
  if (r && r.plannedAt !== null) {
    r.calledAt = now;
  }
}
// Tool enumeration is stronger than initialize: the client has loaded the room
// tool definitions. This is a startup signal only, never permission to type.
const listedListeners = new Set<(paneid: string) => void>();
export function onListed(fn: (paneid: string) => void): void { listedListeners.add(fn); }
export function noteListed(paneid: string, generation: number, now = Date.now()): void {
  const r = panes.get(paneid);
  if (!r || r.plannedAt === null || !Number.isSafeInteger(generation) || generation < 0 || r.listed?.generation === generation) return;
  r.listed = { generation, at: now };
  for (const fn of listedListeners) {
    try { fn(paneid); } catch { /* observers cannot fail the MCP response */ }
  }
}
export function listedAt(paneid: string, generation: number): number | null {
  const r = panes.get(paneid);
  return r?.listed?.generation === generation ? r.listed.at : null;
}

// A failed MCP handshake must not suppress room notifications forever. This
// fixed launch deadline is independent of the observational TOOLS_SECS setting.
export const CODEX_STARTUP_WAIT_MS = 30_000;
export function startupDeadline(paneid: string): number | null {
  const at = panes.get(paneid)?.plannedAt;
  return at == null ? null : at + CODEX_STARTUP_WAIT_MS;
}

export function drop(paneid: string): void {
  panes.delete(paneid);
}
export const isPlanned = (paneid: string): boolean => (panes.get(paneid)?.plannedAt ?? null) !== null;

export function state(paneid: string, now = Date.now()): { tools: 'room' | 'none' | 'unknown'; reason?: string } {
  const r = panes.get(paneid);
  if (!r) return { tools: 'unknown' };
  if (r.plannedAt === null) return r.why ? { tools: 'unknown', reason: r.why } : { tools: 'unknown' };
  if (r.calledAt !== null) return { tools: 'room' };
  if (now - r.plannedAt >= TOOLS_SECS * 1000) return { tools: 'none', reason: 'never-connected' };
  return { tools: 'unknown' };
}

/** True exactly once per planned pane, when its state first reads none (the room fact). */
export function shouldSayNone(paneid: string, now = Date.now()): boolean {
  const r = panes.get(paneid);
  if (!r || r.said || state(paneid, now).tools !== 'none') return false;
  r.said = true;
  return true;
}
