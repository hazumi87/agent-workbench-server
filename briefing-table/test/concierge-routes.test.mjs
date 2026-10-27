/**
 * The Concierge's read scope through the REAL pane-token door (docs/specs/
 * concierge.md P0 acceptance: limited access for the designated pane; denial
 * for any other pane, for the shared bearer and for no credential; the off
 * switch; revocation when the concierge session ends).
 *
 * One scratch engine on P() ports with HARBOR_WB_PANE_TOKENS=1, a temp mapping
 * db, NO broker and NO pty. Live rows and a room come from rooms-routes.seed.ts;
 * pane tokens from concierge.seed.ts (only a spawn mints one, and there is none).
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const PORT = P(514);
const DEAD_BROKER = P(515);
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'concierge-routes-token';
const TOK = { cg: 'tok-concierge-primary', fresh: 'tok-concierge-fresh', other: 'tok-other-agent' };

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

async function run() {
  for (const p of [PORT, DEAD_BROKER]) {
    await assertFree(p, 'concierge-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-concierge-routes-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const seedWith = async (script, plan) => {
    const r = await runTsx([join('test', script), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`${script} failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  const seed = (plan) => seedWith('rooms-routes.seed.ts', plan);
  let engine = null;
  let log = '';
  try {
    await seed({
      recipes: [
        { id: 'rec-cg', name: 'Concierge', projectDir: '/srv/x/concierge', vendor: 'claude-code', agent: 'concierge' },
        { id: 'rec-b', name: 'Builder', projectDir: '/srv/x/b', vendor: 'claude-code', agent: 'builder' },
      ],
    });
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_PANE_TOKENS: '1',
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      await sleep(250);
      up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) {
      throw new Error(`engine did not come up\n${log}`);
    }
    await seed({
      sessions: [
        { paneid: 'recipe:rec-cg', recipe_id: 'rec-cg', vendor: 'claude-code', agent: 'concierge', session_id: 's-cg', state: 'live' },
        { paneid: 'recipe:rec-cg#fresh001', recipe_id: 'rec-cg', vendor: 'claude-code', agent: 'concierge', session_id: 's-cg2', state: 'live' },
        { paneid: 'recipe:rec-b', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'builder', session_id: 's-b', state: 'live' },
      ],
    });
    await seedWith('concierge.seed.ts', {
      tokens: [
        { paneid: 'recipe:rec-cg', token: TOK.cg },
        { paneid: 'recipe:rec-cg#fresh001', token: TOK.fresh },
        { paneid: 'recipe:rec-b', token: TOK.other },
      ],
    });
    const login = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(TOKEN)}`, redirect: 'manual' });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const call = async (path, { method = 'GET', json, as = 'none' } = {}) => {
      const headers = {};
      if (as === 'cookie') headers.cookie = cookie;
      else if (as === 'bearer') headers.authorization = `Bearer ${TOKEN}`;
      else if (as !== 'none') headers.authorization = `Bearer ${as}`;
      const init = { method, headers, redirect: 'manual' };
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetch(BASE + path, init);
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not json */
      }
      return { status: res.status, body };
    };

    /* a room the concierge can see */
    const room = await call('/api/rooms', { method: 'POST', json: { name: 'Alpha' }, as: 'cookie' });
    await call(`/api/rooms/${room.body.id}/seats`, { method: 'POST', json: { recipe_id: 'rec-b', occupant: 'recipe:rec-b', handle: 'builder' }, as: 'cookie' });
    await call(`/api/rooms/${room.body.id}`, { method: 'PATCH', json: { brief: 'Build the hello page' }, as: 'cookie' });

    console.log('\n[settings: a person turns it on]');
    let r = await call('/api/concierge', { as: 'bearer' });
    ok(r.status === 200 && r.body.prerequisite?.paneTokens === true && r.body.pane === null, 'status: pane tokens on, no concierge yet');
    r = await call('/api/concierge', { method: 'PATCH', json: { enabled: true, primary: 'rec-cg' }, as: 'bearer' });
    ok(r.status === 403, 'the shared bearer cannot turn it on');
    r = await call('/api/concierge', { method: 'PATCH', json: { enabled: true, primary: 'rec-cg' }, as: 'cookie' });
    ok(r.status === 200 && r.body.pane === 'recipe:rec-cg' && r.body.live === true, 'a person turns it on: the pane is recipe:rec-cg, and it is running');

    console.log('\n[the read scope]');
    r = await call('/api/concierge/rooms');
    ok(r.status === 401, 'no credential: 401');
    r = await call('/api/concierge/rooms', { as: 'bearer' });
    ok(r.status === 403 && r.body?.error === 'concierge_scope', 'the shared bearer: 403, never a fallback');
    r = await call('/api/concierge/rooms', { as: TOK.cg });
    const alpha = (r.body?.rooms ?? []).find((x) => x.id === room.body.id);
    ok(r.status === 200 && !!alpha, "the concierge pane's token reads the open rooms");
    ok(!!alpha && alpha.brief === 'Build the hello page' && alpha.lead === 'builder' && alpha.seats?.[0]?.handle === 'builder', 'with brief, lead and roster');
    ok(!!alpha && typeof alpha.unread === 'number' && Array.isArray(alpha.apps) && 'held' in (alpha.seats?.[0] ?? {}), 'with unread, apps and held per seat');
    r = await call('/api/concierge/sessions', { as: TOK.cg });
    const rows = r.body?.sessions ?? [];
    const b = rows.find((s) => s.paneid === 'recipe:rec-b');
    ok(r.status === 200 && !!b && b.name === 'Builder' && b.rooms?.[0]?.seat === 'builder', 'the live sessions, with where each one sits');
    const leaked = rows.flatMap((s) => Object.keys(s)).filter((k) => ['session_id', 'meta', 'body', 'text', 'draft', 'token', 'projectDir', 'logo'].includes(k));
    ok(leaked.length === 0, `no content, ids or paths in a session row (${leaked.join(',') || 'none'})`);
    r = await call('/api/concierge/recipes/rec-b/sessions', { as: TOK.cg });
    ok(r.status === 200 && Array.isArray(r.body?.sessions), "a project's session listing");
    r = await call('/api/concierge/rooms', { as: TOK.fresh });
    ok(r.status === 403 && r.body?.error === 'not_concierge', 'a fresh pane of the SAME recipe: 403');
    r = await call('/api/concierge/rooms', { as: TOK.other });
    ok(r.status === 403, 'another agent: 403');
    r = await call('/api/table', { as: TOK.cg });
    ok(r.status === 403 && r.body?.error === 'not_for_pane_token', 'the concierge token still reaches nothing else (default deny)');
    r = await call('/api/concierge', { method: 'PATCH', json: { enabled: false }, as: TOK.cg });
    ok(r.status === 403, 'the concierge cannot change its own settings');

    console.log('\n[the badge field]');
    r = await call('/api/rooms/me/unread', { as: 'cookie' });
    ok(r.status === 200 && r.body?.concierge && typeof r.body.concierge.unread === 'number', '/api/rooms/me/unread carries its own concierge field');

    console.log('\n[off switch, and the session ending]');
    await call('/api/concierge', { method: 'PATCH', json: { enabled: false }, as: 'cookie' });
    r = await call('/api/concierge/rooms', { as: TOK.cg });
    ok(r.status === 403, 'off: the very next request is refused');
    r = await call('/api/rooms/me/unread', { as: 'cookie' });
    ok(r.status === 200 && !('concierge' in (r.body ?? {})), 'off: no concierge field');
    await call('/api/concierge', { method: 'PATCH', json: { enabled: true }, as: 'cookie' });
    r = await call('/api/concierge/rooms', { as: TOK.cg });
    ok(r.status === 200, 'back on: readable again');
    await seedWith('concierge.seed.ts', { states: [{ paneid: 'recipe:rec-cg', state: 'dehydrated' }] });
    r = await call('/api/concierge/rooms', { as: TOK.cg });
    ok(r.status === 401 && r.body?.error === 'pane_not_live', 'the concierge session ended: its token is dead (401 pane_not_live)');
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

run()
  .catch((err) => {
    failed++;
    console.log(`  FAIL run aborted: ${err?.stack ?? err}`);
  })
  .finally(() => {
    console.log(`PASS ${passed} FAIL ${failed}`);
    process.exit(failed ? 1 : 0);
  });
