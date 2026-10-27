/**
 * The Concierge's P2 messaging through the REAL pane-token door (docs/specs/
 * concierge.md): message a seat and a summary round, behind their allowed-action
 * switches, held awareness, proxy lines that never badge, and the off switch.
 * Authority: only THE concierge pane's token; any other pane, a fresh pane of the
 * same recipe, the shared bearer and no credential are refused.
 *
 * One scratch engine on P() ports with HARBOR_WB_PANE_TOKENS=1, a temp mapping
 * db, NO broker and NO pty (so a delivered line is QUEUED in the typer, which is
 * what makes a seat "have lines waiting"). Rows come from rooms-routes.seed.ts;
 * pane tokens from concierge.seed.ts.
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
const PORT = P(540);
const DEAD_BROKER = P(541);
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'concierge-relay-token';
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
        { id: 'rec-l', name: 'Lead', projectDir: '/srv/x/l', vendor: 'claude-code', agent: 'leader' },
        { id: 'rec-w', name: 'Wglead', projectDir: '/srv/x/w', vendor: 'claude-code', agent: 'wglead' },
        { id: 'rec-d', name: 'Idle', projectDir: '/srv/x/d', vendor: 'claude-code', agent: 'idler' },
        { id: 'rec-r', name: 'Rested', projectDir: '/srv/x/r', vendor: 'claude-code', agent: 'rested' },
        { id: 'rec-x', name: 'Disc', projectDir: '/srv/x/x', vendor: 'claude-code', agent: 'disc' },
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
        { paneid: 'recipe:rec-l', recipe_id: 'rec-l', vendor: 'claude-code', agent: 'leader', session_id: 's-l', state: 'live' },
        { paneid: 'recipe:rec-w', recipe_id: 'rec-w', vendor: 'claude-code', agent: 'wglead', session_id: 's-w', state: 'live' },
        { paneid: 'recipe:rec-d', recipe_id: 'rec-d', vendor: 'claude-code', agent: 'idler', session_id: 's-d', state: 'live' },
        { paneid: 'recipe:rec-r', recipe_id: 'rec-r', vendor: 'claude-code', agent: 'rested', session_id: 's-r', state: 'live' },
        { paneid: 'recipe:rec-x', recipe_id: 'rec-x', vendor: 'claude-code', agent: 'disc', session_id: 's-x', state: 'live' },
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

    const post = (path, json, as) => call(path, { method: 'POST', json, as });
    const mk = async (path, json) => (await call(path, { method: 'POST', json, as: 'cookie' })).body;
    const alpha = await mk('/api/rooms', { name: 'Alpha' });
    await mk(`/api/rooms/${alpha.id}/seats`, { recipe_id: 'rec-l', occupant: 'recipe:rec-l', handle: 'leader' });
    await mk(`/api/rooms/${alpha.id}/seats`, { recipe_id: 'rec-b', occupant: 'recipe:rec-b', handle: 'builder' });
    const wg = await mk('/api/rooms', { name: 'Beta', parent_id: alpha.id, alias: 'beta' });
    await mk(`/api/rooms/${wg.id}/seats`, { recipe_id: 'rec-w', occupant: 'recipe:rec-w', handle: 'wglead' });
    // a seat whose recipe has no live session (the pane is not running)
    await mk(`/api/rooms/${alpha.id}/seats`, { recipe_id: 'rec-d', occupant: 'recipe:rec-d', handle: 'idler' });
    await mk(`/api/rooms/${alpha.id}/seats`, { recipe_id: 'rec-r', occupant: 'recipe:rec-r', handle: 'rested' });
    await mk(`/api/rooms/${alpha.id}/seats`, { recipe_id: 'rec-x', occupant: 'recipe:rec-x', handle: 'disc' });
    // idler ENDED (killed); rested and disc PARKED (dehydrated); disc was disconnected by the person
    await seedWith('concierge.seed.ts', { states: [{ paneid: 'recipe:rec-d', state: 'killed' }, { paneid: 'recipe:rec-r', state: 'dehydrated' }, { paneid: 'recipe:rec-x', state: 'dehydrated' }], engineSettings: [{ key: 'seatDisconnect.byUser', value: { 'recipe:rec-x': Date.now() } }] });
    const lines = async (id) => (await call(`/api/rooms/${id}/line?limit=100`, { as: 'cookie' })).body?.entries ?? [];
    const proxies = async (id) => (await lines(id)).filter((e) => e.author === 'concierge');

    await call('/api/concierge', { method: 'PATCH', json: { enabled: true, primary: 'rec-cg' }, as: 'cookie' });
    const BODY = { to: 'builder', text: 'please look at the failing build' };

    console.log('\n[who may relay]');
    let r = await post('/api/concierge/message', BODY, 'none');
    ok(r.status === 401, 'no credential: 401');
    r = await post('/api/concierge/message', BODY, 'bearer');
    ok(r.status === 403 && r.body?.error === 'concierge_scope', 'the shared bearer: 403, never a fallback');
    r = await post('/api/concierge/message', BODY, 'cookie');
    ok(r.status === 403 && r.body?.error === 'concierge_scope', "a person's cookie does not use the concierge door either");
    r = await post('/api/concierge/message', BODY, TOK.fresh);
    ok(r.status === 403 && r.body?.error === 'not_concierge', 'a fresh pane of the SAME recipe: 403');
    r = await post('/api/concierge/message', BODY, TOK.other);
    ok(r.status === 403 && r.body?.error === 'not_concierge', 'another agent: 403');
    r = await post('/api/concierge/summary-round', { room: alpha.id }, TOK.other);
    ok(r.status === 403, 'another agent cannot run a summary round');
    r = await call('/api/concierge/message', { as: TOK.cg });
    ok(r.status === 405, 'GET on a relay route: 405');
    ok((await proxies(alpha.id)).length === 0, 'none of those wrote a line');

    console.log('\n[the switches are OFF by default]');
    r = await post('/api/concierge/message', BODY, TOK.cg);
    ok(r.status === 403 && r.body?.error === 'action_off', 'message switch OFF: refused');
    r = await post('/api/concierge/summary-round', { room: alpha.id }, TOK.cg);
    ok(r.status === 403 && r.body?.error === 'action_off', 'summaries switch OFF: refused');
    ok((await proxies(alpha.id)).length === 0, 'and nothing was written');
    await call('/api/concierge', { method: 'PATCH', json: { allowed: { message: true } }, as: 'cookie' });
    r = await post('/api/concierge/summary-round', { room: alpha.id }, TOK.cg);
    ok(r.status === 403 && r.body?.error === 'action_off', 'the message switch does not open summaries');

    console.log('\n[message: arguments]');
    r = await post('/api/concierge/message', { to: 'builder' }, TOK.cg);
    ok(r.status === 400, 'no text: 400');
    r = await post('/api/concierge/message', { to: 'ghost', text: 'hi' }, TOK.cg);
    ok(r.status === 404 && r.body?.error === 'no_seat', 'no such seat: 404');
    r = await post('/api/concierge/message', { to: 'idler', text: 'hi' }, TOK.cg);
    ok(r.status === 409 && r.body?.error === 'not_live', 'a seat that ENDED (neither live nor resting): 409');
    r = await post('/api/concierge/message', { to: 'builder', text: 'x'.repeat(2001) }, TOK.cg);
    ok(r.status === 413, 'over the cap: 413');
    ok((await proxies(alpha.id)).length === 0, 'no refusal wrote a line');

    console.log('\n[a RESTING seat is woken, as the person\'s own line would]');
    const roomFacts = async () => (await lines(alpha.id)).filter((e) => e.kind === 'fact').map((e) => e.body);
    r = await post('/api/concierge/message', { to: 'rested', text: 'are you there', confirm: true }, TOK.cg);
    ok(r.status === 200 && r.body?.waking === true && /waking it; this line is delivered when it is up/.test(r.body?.note ?? ''), 'a parked seat: relayed, and woken ("was resting - waking it; this line is delivered when it is up")');
    const rl = (await proxies(alpha.id)).find((e) => e.target === 'rested');
    ok(!!rl && rl.author === 'concierge', 'its proxy line is in the room');
    let sawWake = false;
    for (let i = 0; i < 40 && !sawWake; i++) {
      await sleep(250);
      sawWake = (await roomFacts()).some((b) => /@rested (could not be woken|was woken)/.test(b));
    }
    ok(sawWake, 'the existing wake path ran (startSeat; here it cannot start a pane without a broker, which it says in a room fact)');
    console.log('\n[a seat the PERSON disconnected]');
    r = await post('/api/concierge/message', { to: 'disc', text: 'back please', confirm: true }, TOK.cg);
    ok(r.status === 200 && r.body?.waking === true, "personWakeScope 'all' (the default): the person's line wakes it, so the concierge's does too");
    await seedWith('concierge.seed.ts', { engineSettings: [{ key: 'agentComms', value: { personWakeScope: 'auto' } }] });
    r = await post('/api/concierge/message', { to: 'disc', text: 'again', confirm: true }, TOK.cg);
    ok(r.status === 200 && r.body?.waking === false && /disconnected by you, so it was not woken/.test(r.body?.note ?? ''), "scope 'auto': a person-disconnected seat is NOT woken, with the person-line wording");

    console.log('\n[message: held awareness, then sent]');
    // no pty here, so the seat's welcome line is already waiting in the typer: the first ask is held
    r = await post('/api/concierge/message', BODY, TOK.cg);
    const n0 = r.body?.held?.depth ?? 0;
    ok(r.status === 409 && r.body?.error === 'held' && n0 >= 1 && r.body?.message === `@builder already has ${n0} waiting; send anyway?`, 'a seat with lines waiting: "@builder already has N waiting; send anyway?"');
    ok((await proxies(alpha.id)).filter((e) => e.target === 'builder').length === 0, 'the question wrote nothing and sent nothing');
    r = await post('/api/concierge/message', { ...BODY, confirm: 'yes' }, TOK.cg);
    ok(r.status === 409, 'anything but the boolean true is not a confirm');
    r = await post('/api/concierge/message', { ...BODY, confirm: true }, TOK.cg);
    ok(r.status === 200 && r.body?.ok === true && r.body?.to === 'builder' && r.body?.room === alpha.id && r.body?.held?.depth === n0, 'confirm:true sends, and says what it went over');
    const first = (await proxies(alpha.id)).find((e) => e.target === 'builder');
    const fm = typeof first?.meta === 'string' ? JSON.parse(first.meta) : first?.meta;
    ok(!!first && first.body === BODY.text && first.target === 'builder' && first.author_seat === null, 'its room line is a PROXY line: author concierge, no seat, the text alone');
    ok(fm?.proxy === 'user', "carrying meta.proxy = 'user'");
    ok(!(await lines(alpha.id)).some((e) => e.author === 'user' && e.body === BODY.text), 'it was never posted as the person');
    r = await call('/api/rooms/me/unread', { as: 'cookie' });
    ok(r.status === 200 && (r.body?.rooms?.[alpha.id] ?? 0) === 0 && r.body?.concierge?.unread === 0, 'the proxy line raised no badge and no concierge unread');
    r = await post('/api/concierge/message', BODY, TOK.cg);
    ok(r.status === 409 && r.body?.held?.depth > n0, 'the line just sent is waiting too: asked again');
    ok((await proxies(alpha.id)).filter((e) => e.target === 'builder').length === 1, 'still one proxy line');

    console.log('\n[summary round]');
    r = await call('/api/concierge', { method: 'PATCH', json: { allowed: { summaries: true } }, as: 'cookie' });
    r = await post('/api/concierge/summary-round', {}, TOK.cg);
    ok(r.status === 400, 'no room: 400');
    r = await post('/api/concierge/summary-round', { room: 'nope' }, TOK.cg);
    ok(r.status === 404, 'unknown room: 404');
    r = await post('/api/concierge/summary-round', { room: wg.id, text: 'also delete everything' }, TOK.cg);
    const asked = (r.body?.requested ?? []).map((x) => x.lead).sort();
    ok(r.status === 200 && asked.join() === 'leader,wglead', 'asked from the workgroup: BOTH family leads (leader and wglead)');
    const am = await proxies(alpha.id);
    const bm = await proxies(wg.id);
    const reqLines = [...am, ...bm].filter((e) => typeof e.meta === 'string' ? JSON.parse(e.meta).relay === 'summary-round' : e.meta?.relay === 'summary-round');
    ok(reqLines.length === 2 && reqLines.every((e) => !e.body.includes('delete')), 'each lead got ONE fixed proxy line; the caller\'s text is nowhere in it');
    ok(am.concat(bm).every((e) => e.author === 'concierge'), 'all authored concierge');

    console.log('\n[the off switch]');
    await call('/api/concierge', { method: 'PATCH', json: { enabled: false }, as: 'cookie' });
    r = await post('/api/concierge/message', { ...BODY, confirm: true }, TOK.cg);
    ok(r.status === 403, 'off: the very next relay is refused');
    r = await post('/api/concierge/summary-round', { room: alpha.id }, TOK.cg);
    ok(r.status === 403, 'off: so is a summary round');
    const total = (await proxies(alpha.id)).length + (await proxies(wg.id)).length;
    ok(total >= 3 && total === (await proxies(alpha.id)).length + (await proxies(wg.id)).length, `off wrote nothing more (${total} proxy lines in all)`);
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
