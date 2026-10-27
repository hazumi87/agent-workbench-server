/**
 * The hooks file the engine writes for a Codex pane (Owner 2026-10-03, Codex
 * vendor): `<projectDir>/.codex/hooks.json`, schema
 * `{"hooks":{"<Event>":[{"hooks":[{"type":"command","command":"..."}]}]}}`.
 *
 * Each of our entries posts the hook's stdin JSON to the engine's
 * `/api/agent-hook`, carrying the pane id from the environment the engine put
 * in the pane (`HARBOR_WB_PANEID`; Codex's shell env inherits it). That route
 * is write-only and loopback-only (auth.isLocalHookDelivery) — the command
 * holds no credential, which is the whole reason it is allowed to exist.
 *
 * MERGE, NEVER REPLACE: other hooks in the file (a human's, another tool's)
 * are kept; only entries carrying OUR marker (the `/api/agent-hook?` URL) are
 * replaced, so the write is idempotent and a port change heals itself. A file
 * that is not valid JSON is LEFT ALONE (skipped, with the reason): overwriting
 * it would destroy something we do not understand.
 *
 * The vendor launches with `--dangerously-bypass-hook-trust`, which is only
 * sound because this module vets what it writes: one fixed command shape, no
 * interpolation of anything but the port.
 *
 * The pure half (`mergeHooks`) takes no filesystem; `ensureHooksFile` is the
 * thin shell around it. Neither throws: a launch must never fail on hooks —
 * the cost of a skip is "no rings", never "no session".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The events we subscribe to. SessionEnd is unreliable (process exit is the
 *  authority) and Interrupt is untested; both are cheap to listen to. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'Interrupt',
] as const;

/** What marks an entry as ours. */
export const HOOK_MARKER = '/api/agent-hook?';

/* THE PANE ID IS ENCODED FOR TRANSPORT ONLY (switch spec §3 item 5; ticket's likely root
   cause). A fresh pane is `recipe:<id>#<8hex>`, and an unencoded `#` in a URL starts a FRAGMENT,
   which curl never sends: the engine heard `recipe:<id>`, matched no live pane, and every hook
   of a fresh Codex pane was a silent no-op (no session id ever banked). In the pane-id alphabet
   ([A-Za-z0-9:_#.-], agent-hook.ts) `#` is the only character a query cannot carry as is, so it
   becomes %23 and the route's URLSearchParams decodes the real id back. POSIX sh + sed, so the
   command runs the same under dash, bash and Git Bash; printf/sed never read the hook's stdin,
   which still goes to curl untouched. */
const PANEID_FOR_URL = `$(printf '%s' "$HARBOR_WB_PANEID" | sed 's/#/%23/g')`;

export function hookCommand(port: number): string {
  const url = `http://127.0.0.1:${Math.trunc(port)}${HOOK_MARKER}vendor=codex-cli&paneid=${PANEID_FOR_URL}`;
  return `curl -s -m 3 -X POST "${url}" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
}

type Json = Record<string, any>;

const isOurs = (h: any): boolean => !!h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER);

/** The hooks object with our entries (re)placed. `existing` is the parsed file
 *  (or null for none). Foreign hooks and unknown top-level keys survive. */
export function mergeHooks(existing: unknown, port: number): Json {
  const root: Json = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Json) } : {};
  const hooks: Json = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks) ? { ...root.hooks } : {};
  for (const ev of HOOK_EVENTS) {
    const groups: any[] = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      // a group we emptied is ours to drop; a foreign group with no `hooks` array is left as found
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    kept.push({ hooks: [{ type: 'command', command: hookCommand(port) }] });
    hooks[ev] = kept;
  }
  root.hooks = hooks;
  return root;
}

export type EnsureResult =
  | { status: 'written' | 'unchanged'; path: string }
  | { status: 'skipped'; path: string; reason: string };

export function ensureHooksFile(projectDir: string, port: number): EnsureResult {
  const path = join(projectDir, '.codex', 'hooks.json');
  try {
    let existing: unknown = null;
    let before = '';
    if (existsSync(path)) {
      before = readFileSync(path, 'utf8');
      try {
        existing = JSON.parse(before);
      } catch {
        return { status: 'skipped', path, reason: 'existing hooks.json is not valid JSON — left alone' };
      }
    }
    const next = `${JSON.stringify(mergeHooks(existing, port), null, 2)}\n`;
    if (next === before) {
      return { status: 'unchanged', path };
    }
    mkdirSync(dirname(path), { recursive: true });
    // 0644: the pane runs as another account (chat-ops) and must read it.
    writeFileSync(path, next, { mode: 0o644 });
    return { status: 'written', path };
  } catch (e) {
    return { status: 'skipped', path, reason: `cannot write (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
}
