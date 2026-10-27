/**
 * IDENTITY HYGIENE (wr §2.9) — a bare shell carries no slug. room interface T1 [ticket].
 *
 * Owner (2026-09-21): "I think we need to differentiate agent-driven logins
 * versus a terminal." Two plain SSH terminals (`server svc-ops`, `server owner`)
 * both derived `code` from `/srv/code` — a project id that names no
 * registry node, claimed by two unrelated terminals on two hosts. The rule:
 * a recipe carries an identity if it runs a BRAND agent, or a human typed one.
 *
 * What this file proves, in order:
 *   1. derive per vendor: every brand derives, a terminal / unknown / missing
 *      vendor derives nothing; the brand list tracks RECIPE_VENDORS.
 *   2. the FINGERPRINT that tells a folder-derived slug from a typed or
 *      name-derived one without a column.
 *   3. resolveSlug on the write path (typed kept, folder echo dropped).
 *   4. reconcileTerminalSlugs as a pure function.
 *   5. the REAL wiring: a scratch engine booted on a seeded table clears the
 *      folder-derived terminal slugs (logged, one line each), leaves Local Exec
 *      Bridge / typed / brand alone, does not refill; a SECOND boot changes and
 *      logs nothing; the recipe POST and a picker resume agree with the sweep.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE, set BEFORE the store is imported (it
 * reads the path at module load). The scratch engine gets its own P() ports, a
 * DEAD broker port (nothing listens; no pty is ever opened), childEnv(), and a
 * targets list from the env. The real data dir, :7420, :7430 and :8201 are
 * never touched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — plain .mjs helper, no types
import { P, assertFree, childEnv } from './_scratch.mjs';

const dir = mkdtempSync(join(tmpdir(), 'wb-slug-derive-'));
const DB = join(dir, 'mapping.db');
process.env.HARBOR_WB_TABLE = DB;

const store = await import('../src/table/store.ts');
const slug = await import('../src/engine/agent-slug.ts');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT: number = P(60);
const DEAD_BROKER_PORT: number = P(61);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'slug-derive-test-token';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${JSON.stringify(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(cond: unknown, msg: string): void {
  eq(!!cond, true, msg);
}

/* ---------------------------------------------------------------- 1 ---- */
console.log('\n[derive: a brand vendor derives, a terminal derives nothing]');
for (const v of ['claude-code', 'gemini-cli', 'codex-cli', 'ollama']) {
  eq(slug.deriveSlug({ vendor: v, projectDir: '/srv/code/auriga' }), 'auriga', `${v} derives the bare basename`);
}
eq(slug.deriveSlug({ vendor: 'claude-code', projectDir: null, name: 'Home Hub' }), 'home-hub', 'brand falls back to the name');
eq(slug.deriveSlug({ vendor: 'cli-manager', projectDir: '/srv/code' }), null, 'cli-manager at /srv/code: NO slug (was `code`)');
eq(slug.deriveSlug({ vendor: 'cli-manager', projectDir: null, name: 'Local Command Bridge' }), null, 'cli-manager name-only: no slug either');
eq(slug.deriveSlug({ vendor: 'script-widget', projectDir: '/srv/code/x' }), null, 'an unclassified vendor: no slug, never a made-up one');
eq(slug.deriveSlug({ vendor: undefined, projectDir: '/srv/code/x' }), null, 'a missing vendor: no slug');
eq(slug.deriveSlug({ vendor: null, projectDir: '/srv/code/x' }), null, 'a null vendor: no slug');

console.log('\n[the brand list is RECIPE_VENDORS minus the generic shell class]');
eq(
  [...slug.BRAND_VENDORS].sort().join(','),
  store.RECIPE_VENDORS.filter((v) => v !== 'cli-manager').sort().join(','),
  'BRAND_VENDORS == RECIPE_VENDORS - cli-manager (a new brand must be added to both)',
);

/* ---------------------------------------------------------------- 2 ---- */
console.log('\n[the fingerprint: folder-derived vs typed vs name-derived]');
eq(slug.isFolderDerived('code', '/srv/code'), true, 'the bare basename is folder-derived');
eq(slug.isFolderDerived('code-cli', '/srv/code'), true, 'the pre-2026-09-17 `-cli` form is folder-derived too');
eq(slug.isFolderDerived('tmp', '/tmp/'), true, 'trailing separator does not hide it');
eq(slug.isFolderDerived('briefing-table', 'C:\\Code\\briefing-table'), true, 'windows path');
eq(slug.isFolderDerived('Code', '/srv/code'), false, 'only a legal slug matches (case is not normalised here)');
eq(slug.isFolderDerived('local-command-bridge', '/srv/code/agent-rules'), false, 'name-derived: not the folder');
eq(slug.isFolderDerived('local-command-bridge', null), false, 'no folder at all: never folder-derived');
eq(slug.isFolderDerived('my-tool', '/srv/code'), false, 'typed: not the folder');
eq(slug.isFolderDerived(null, '/srv/code'), false, 'no slug: nothing to fingerprint');

/* ---------------------------------------------------------------- 3 ---- */
console.log('\n[resolve on the write path]');
eq(slug.resolveSlug('My Tool', { vendor: 'cli-manager', projectDir: '/srv/code' }), 'my-tool', 'terminal: a TYPED slug is kept (normalised)');
eq(slug.resolveSlug('', { vendor: 'cli-manager', projectDir: '/srv/code' }), null, 'terminal: empty stays empty');
eq(slug.resolveSlug('code', { vendor: 'cli-manager', projectDir: '/srv/code' }), null, 'terminal: the folder echo is dropped (the form re-sends the stored slug)');
eq(slug.resolveSlug('local-command-bridge', { vendor: 'cli-manager', projectDir: null, name: 'Local Command Bridge' }), 'local-command-bridge', 'terminal: a name-shaped slug is kept');
eq(slug.resolveSlug('auriga', { vendor: 'claude-code', projectDir: '/srv/code/auriga' }), 'auriga', 'brand: the folder slug is kept');
eq(slug.resolveSlug(null, { vendor: 'gemini-cli', projectDir: '/srv/code/auriga' }), 'auriga', 'brand: empty derives');

/* ---------------------------------------------------------------- 4 ---- */
console.log('\n[reconcileTerminalSlugs: pure]');
{
  const sets: Array<[string, null]> = [];
  const recs = [
    { id: 'a', name: 'server svc-ops', vendor: 'cli-manager', projectDir: '/srv/code', agent: 'code' },
    { id: 'b', name: 'Old', vendor: 'cli-manager', projectDir: '/srv/code/old', agent: 'old-cli' },
    { id: 'c', name: 'Local Command Bridge', vendor: 'cli-manager', projectDir: '/srv/code/agent-rules', agent: 'local-command-bridge' },
    { id: 'd', name: 'Typed', vendor: 'cli-manager', projectDir: '/srv/code', agent: 'my-tool' },
    { id: 'e', name: 'Auriga', vendor: 'claude-code', projectDir: '/srv/code/auriga', agent: 'auriga' },
    { id: 'f', name: 'Empty', vendor: 'cli-manager', projectDir: '/srv/code', agent: null },
  ];
  const done = slug.reconcileTerminalSlugs(recs, (id, v) => sets.push([id, v]));
  eq(done.map((d) => `${d.id}:${d.cleared}`).join(','), 'a:code,b:old-cli', 'clears exactly the folder-derived terminal slugs');
  eq(sets.map((s) => s.join('=')).join(','), 'a=,b=', 'and calls the setter with null for each');
  const after = recs.map((r) => (sets.some(([id]) => id === r.id) ? { ...r, agent: null } : r));
  eq(slug.reconcileTerminalSlugs(after, () => sets.push(['again', null])).length, 0, 'a second run finds nothing (idempotent)');
}

/* ---------------------------------------------------------------- 5 ---- */
function mkRecipe(id: string, name: string, vendor: string, projectDir: string | null, agent: string | null): void {
  store.upsertRecipe({
    id,
    name,
    target: 'local',
    projectDir,
    vendor,
    agent,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
  });
}
const agentOf = (id: string): string | null | undefined => store.getRecipe(id)?.agent;

/* The live table's shapes (spec §4 T1 gate): the two `code` terminals, `tmp`,
   the name-derived Local Command Bridge — plus the controls around them. */
mkRecipe('t-svc-ops', 'server svc-ops', 'cli-manager', '/srv/code', 'code');
mkRecipe('t-owner', 'server owner', 'cli-manager', '/srv/code', 'code');
mkRecipe('t-tmp', 'VRPC tmp', 'cli-manager', 'C:/tmp', 'tmp');
mkRecipe('t-oldform', 'Old form', 'cli-manager', '/srv/code/olddef', 'olddef-cli');
mkRecipe('t-bridge', 'Local Command Bridge', 'cli-manager', null, 'local-command-bridge');
mkRecipe('t-typed', 'Typed terminal', 'cli-manager', '/srv/code', 'my-tool');
mkRecipe('t-empty', 'Empty terminal', 'cli-manager', '/srv/code/empty', null);
mkRecipe('b-auriga', 'Auriga', 'claude-code', '/srv/code/auriga', 'auriga');
mkRecipe('b-gemini-empty', 'Gemini empty', 'gemini-cli', '/srv/code/kiosk/', null);
/* A pane row left over from before the sweep: killed, still wearing `code`.
   A picker resume must stamp the RECIPE's slug, not this one. */
store.upsert({
  paneid: 'recipe:t-svc-ops',
  recipe_id: 't-svc-ops',
  server: 'local',
  vendor: 'cli-manager',
  agent: 'code',
  session_id: null,
  state: 'killed',
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function call(path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(BASE + path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* status is what matters */
  }
  return { status: res.status, body: parsed };
}

async function bootEngine(): Promise<{ proc: ChildProcess; log: () => string }> {
  let out = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: DB,
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_IDENTITY_DB: join(dir, 'identity.db'),
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(dir, 'claude-projects'),
      HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local' }] }),
    }),
  });
  proc.stdout?.on('data', (d) => {
    out += d;
  });
  proc.stderr?.on('data', (d) => {
    out += d;
  });
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  return { proc, log: () => out };
}

async function stopEngine(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }
  const gone = new Promise<void>((r) => proc.once('exit', () => r()));
  proc.kill('SIGTERM');
  await Promise.race([gone, sleep(5000)]);
  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
    await gone;
  }
}

const CLEAR_LINE = /agent slug "([^"]+)" cleared/g;
let engine: ChildProcess | null = null;
try {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'agent-slug-derive.test.ts');
  }

  console.log('\n[boot 1: the sweep, through the real engine]');
  const first = await bootEngine();
  engine = first.proc;
  eq((await call('/health')).status, 200, 'scratch engine answers /health');
  eq(agentOf('t-svc-ops'), null, 'server svc-ops: `code` cleared');
  eq(agentOf('t-owner'), null, 'server owner: `code` cleared');
  eq(agentOf('t-tmp'), null, 'VRPC tmp: `tmp` cleared');
  eq(agentOf('t-oldform'), null, 'the old `<basename>-cli` form on a terminal: cleared');
  eq(agentOf('t-bridge'), 'local-command-bridge', 'Local Command Bridge (name-derived): unchanged');
  eq(agentOf('t-typed'), 'my-tool', 'a typed terminal slug: unchanged');
  eq(agentOf('t-empty'), null, 'an empty terminal is NOT refilled by the backfill');
  eq(agentOf('b-auriga'), 'auriga', 'a brand recipe: unchanged');
  eq(agentOf('b-gemini-empty'), 'kiosk', 'an empty brand recipe is still backfilled (trailing slash and all)');
  const cleared1 = [...first.log().matchAll(CLEAR_LINE)].map((m) => m[1]).sort();
  eq(cleared1.join(','), 'code,code,olddef-cli,tmp', 'each clear is logged, one line per recipe');
  ok(/"server svc-ops": agent slug "code" cleared/.test(first.log()), 'the log line names the recipe');

  console.log('\n[the write path agrees with the sweep]');
  const post = async (b: Record<string, unknown>) => (await call('/api/recipes', { json: { target: 'local', ...b } })).body;
  const fresh = await post({ name: 'New terminal', vendor: 'cli-manager', projectDir: '/srv/code', agent: '' });
  ok(fresh?.recipe?.id, 'POST terminal saves');
  eq(fresh?.recipe?.agent, null, 'POST terminal, empty slug: null');
  const typed = await post({ name: 'Named tool', vendor: 'cli-manager', projectDir: '/srv/code', agent: 'Named Tool' });
  eq(typed?.recipe?.agent, 'named-tool', 'POST terminal, typed slug: kept (normalised)');
  const echo = await post({ name: 'Switched', vendor: 'cli-manager', projectDir: '/srv/code/switched', agent: 'switched' });
  eq(echo?.recipe?.agent, null, 'POST terminal carrying its folder slug (a brand switched to a terminal): dropped');
  const brand = await post({ name: 'Brand', vendor: 'claude-code', projectDir: '/srv/code/brandy', agent: '' });
  eq(brand?.recipe?.agent, 'brandy', 'POST brand, empty slug: derived');
  const legacy = await post({ name: 'Legacy client', runClaude: false, projectDir: '/srv/code/legacy', agent: '' });
  eq(legacy?.recipe?.agent, null, 'POST from an old client (runClaude:false, no vendor): no slug');

  console.log('\n[picker resume stamps the recipe slug, not the stale row]');
  const picked = '11111111-2222-4333-8444-555555555555';
  const launch = await call('/api/recipes/t-svc-ops/launch', {
    json: { resumeSessionId: picked, target: 'tab', surface: 'browser' },
  });
  eq(launch.status, 200, 'picker launch answers (browser tab: nothing opened)');
  const row = store.get('recipe:t-svc-ops') as { agent?: string | null; session_id?: string | null } | undefined;
  eq(row?.session_id, picked, 'the row now banks the picked session');
  eq(row?.agent, null, 'and carries the recipe slug (null), not the stale `code`');

  await stopEngine(engine);
  engine = null;

  console.log('\n[boot 2: a second boot changes nothing]');
  const before = store.listRecipes().map((r) => `${r.id}=${r.agent}`).sort().join(',');
  const second = await bootEngine();
  engine = second.proc;
  eq((await call('/health')).status, 200, 'scratch engine answers /health again');
  const after = store.listRecipes().map((r) => `${r.id}=${r.agent}`).sort().join(',');
  eq(after, before, 'every recipe slug is identical after the second boot');
  eq([...second.log().matchAll(CLEAR_LINE)].length, 0, 'and nothing is logged as cleared');
  ok(!/agent slug derived/.test(second.log()), 'and nothing is re-derived');
} catch (err) {
  failed += 1;
  console.log(`  ✗ threw: ${(err as Error).stack ?? err}`);
} finally {
  if (engine) {
    await stopEngine(engine);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* held open by better-sqlite3 until exit */
  }
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
