/* FIRST-RUN SETUP routes for the hosted web UI (web-first pilot, shapes ruled by application 2026-10-26):
 *   GET|PUT /api/settings/setup        {completedAt, defaultFolder, hosted, bareShell}: the person's setup state (one person per server). completedAt is stamped by the ENGINE on the PUT that finishes setup
 *                                      ({complete:true}); defaultFolder (absolute, exists, inside the folder-picker root) is the default for NEW rooms. Person only, both verbs.
 *   GET  /api/agents/status            {vendors:[{id, installed: true|false|null, reason?}]}: is the vendor's CLI installed. INSTALLED ONLY: nothing probes a sign-in. null = the engine's
 *                                      account cannot tell (the CLI may live in another account's home); false only when the search was complete.
 *   POST /api/agents/:vendor/sign-in   person only. Makes (or refreshes) the recipe "Sign in to <vendor>", a hidden-from-nothing ordinary recipe whose command is the engine's own allow-listed sign-in
 *                                      entry (never a request field) and answers {recipeId}; the page starts it through the existing session create, which spawns it directly as argv. The person finishes in that pane. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readBody, sendJson } from './http-util.ts';
import { fsRoot } from './settings-routes.ts';
import { resolveBinary } from '../engine/argv.ts';
import { table } from '../table/endpoint.ts';

const SETUP_KEY = 'setup';

/** The vendor table's sign-in entries: the program to look for and the argv that starts its own sign-in. */
export const AGENT_VENDORS: ReadonlyArray<{ id: string; label: string; bin: string; signIn: readonly string[] }> = [
  { id: 'claude-code', label: 'Claude Code', bin: 'claude', signIn: ['claude'] }, // the person runs /login in its screen
  { id: 'codex-cli', label: 'Codex', bin: 'codex', signIn: ['codex', 'login'] },
  { id: 'gemini-cli', label: 'Gemini CLI', bin: 'gemini', signIn: ['gemini'] }, // asks to sign in on first run
];

export interface SetupDeps {
  human: boolean;
  /** run one call through the engine's own routes with the person's credentials (for the recipe create) */
  dispatch: (call: { method: string; path: string; body: Record<string, unknown> | null }, cookie: string) => Promise<{ status: number; text: string }>;
}

/** The engine's OWN profile, for the page to key on (never inferred from a refusal): `hosted` = HARBOR_WB_HOSTED=1; `bareShell` = whether this engine will open a bare shell (a recipe with no program).
 *  A hosted engine never does (launch.ts: no-cli), so the page must not offer the built-in Shell there. Additive: no existing field changes. */
const withProfile = <T extends object>(state: T): T & { hosted: boolean; bareShell: boolean } => {
  const hosted = process.env.HARBOR_WB_HOSTED === '1';
  return { ...state, hosted, bareShell: !hosted };
};

const personOnly = (res: ServerResponse): void => void sendJson(res, 403, { error: 'person_only', message: 'only the signed-in person does this' });

interface SetupState {
  completedAt: number | null;
  defaultFolder: string | null;
}
function readSetup(): SetupState {
  const v = table.getEngineSetting(SETUP_KEY) as Partial<SetupState> | null;
  return { completedAt: typeof v?.completedAt === 'number' ? v.completedAt : null, defaultFolder: typeof v?.defaultFolder === 'string' ? v.defaultFolder : null };
}

/** installed for one vendor: true when found; null when the engine cannot see the person's tools (a split-account setup); else false. */
export function installedState(bin: string, env: NodeJS.ProcessEnv = process.env): { installed: boolean | null; reason?: string } {
  if (resolveBinary(bin, env)) return { installed: true };
  if ((env.HARBOR_WB_PANE_TOKEN_DELIVERY ?? '').trim().toLowerCase() === 'env') {
    return { installed: null, reason: "the engine runs as a different account than your terminals, so it cannot look in your folders" };
  }
  return { installed: false };
}

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: SetupDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (route === '/api/settings/setup') {
    if (!deps.human) return personOnly(res), true;
    if (method === 'GET') return sendJson(res, 200, withProfile(readSetup())), true;
    if (method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' }), true;
    const b = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return sendJson(res, 400, { error: 'a JSON body is required' }), true;
    const cur = readSetup();
    let defaultFolder = cur.defaultFolder;
    if ('defaultFolder' in b) {
      if (b.defaultFolder === null || b.defaultFolder === '') {
        defaultFolder = null;
      } else {
        const p = b.defaultFolder;
        if (typeof p !== 'string' || !isAbsolute(p)) return sendJson(res, 400, { error: 'an absolute folder', field: 'defaultFolder' }), true;
        try {
          const real = realpathSync(p);
          const root = fsRoot();
          if (!statSync(real).isDirectory()) throw new Error('not a directory');
          if (real !== root && !real.startsWith(root.endsWith('/') ? root : root + '/')) return sendJson(res, 403, { error: 'outside-root', field: 'defaultFolder' }), true;
          defaultFolder = real;
        } catch {
          return sendJson(res, 400, { error: 'that folder does not exist', field: 'defaultFolder' }), true;
        }
      }
    }
    let completedAt = cur.completedAt;
    if (b.complete === true && completedAt === null) completedAt = Date.now(); // the engine's clock, once
    const next = { completedAt, defaultFolder };
    table.setEngineSetting(SETUP_KEY, next);
    return sendJson(res, 200, withProfile(next)), true;
  }
  if (route === '/api/agents/status') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
    sendJson(res, 200, { vendors: AGENT_VENDORS.map((v) => ({ id: v.id, label: v.label, ...installedState(v.bin) })) });
    return true;
  }
  const m = /^\/api\/agents\/([a-z][a-z0-9-]{0,30})\/sign-in$/.exec(route);
  if (m) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }), true;
    if (!deps.human) return personOnly(res), true;
    const v = AGENT_VENDORS.find((x) => x.id === m[1]);
    if (!v) return sendJson(res, 404, { error: 'no such vendor', field: 'vendor' }), true;
    const id = `signin-${v.id}`;
    /* a plain recipe whose command is OURS (a fixed argv line), run by the existing session create; vendor cli-manager so no resume/session machinery attaches to a login screen */
    const r = await deps.dispatch(
      { method: 'POST', path: '/api/recipes', body: { id, name: `Sign in to ${v.label}`, target: 'local', projectDir: fsRoot(), vendor: 'cli-manager', runClaude: false, initCmd: v.signIn.join(' '), agent: '' } },
      String(req.headers.cookie ?? ''),
    );
    if (r.status >= 300) return sendJson(res, 502, { error: 'could not prepare the sign-in terminal', status: r.status }), true;
    return sendJson(res, 200, { recipeId: id, command: v.signIn.join(' ') }), true;
  }
  return false;
}
