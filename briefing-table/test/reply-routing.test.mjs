/**
 * WHO A REPLY REACHES, through a real scratch engine (Owner [ref], lead ruling [ref]). A reply is routed by its own
 * leading @ list; with none it goes to the author of the line it replies to; an AGENT's reply to a ROOM line (a turn
 * fact, a delivery note) with no @ at all reaches nobody new and is not marked "to the person"; an @ in the middle of a
 * reply still delivers to who it names; a QUOTED @ (in the line it replies to, or in a code span) delivers to no one.
 *
 * SAFETY: scratch engine P(348), dead broker P(349); childEnv(); temp dir removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(348);
const DEAD_BROKER_PORT = P(349);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'reply-routing-test-token';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(path, { method, json, as = 'person' } = {}) {
  const h = as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : {};
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

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
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'reply-routing.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-reply-routing-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  try {
    const recipe = (id, name, vendor) => ({ id, name, projectDir: `/srv/x/${id}`, vendor, agent: id });
    const sess = (n, rec, state) => ({ paneid: `recipe:${rec}#${n}`, recipe_id: rec, vendor: 'claude-code', agent: rec, state });
    const pre = await seed({
      recipes: [recipe('boss', 'Boss', 'claude-code'), recipe('worker', 'Worker', 'claude-code'), recipe('side', 'Side', 'claude-code'), recipe('mem', 'Mem', 'claude-code'), recipe('plain', 'Plain', 'claude-code')],
      sessions: [sess(1, 'boss', 'dehydrated'), sess(1, 'worker', 'dehydrated'), sess(1, 'side', 'dehydrated'), sess(1, 'mem', 'dehydrated'), sess(1, 'plain', 'killed')],
      rooms: [
        {
          name: 'Restart',
          seats: [
            { handle: 'boss', recipe_id: 'boss', occupant: 'recipe:boss#1' }, // the first seat leads
            { handle: 'worker', recipe_id: 'worker', occupant: 'recipe:worker#1' },
            { handle: 'side', recipe_id: 'side', occupant: 'recipe:side#1' },
            { handle: 'mem', recipe_id: 'mem', occupant: 'recipe:mem#1' },
            { handle: 'plain', recipe_id: 'plain', occupant: 'recipe:plain#1' },
          ],
        },
      ],
    });
    const room = pre.rooms[0];
    const meminfo = (availKb, swapFreeKb = 6000000) => writeFileSync(join(tmpDir, 'meminfo'), `MemTotal: 32000000 kB\nMemAvailable: ${availKb} kB\nSwapTotal: 8000000 kB\nSwapFree: ${swapFreeKb} kB\n`);
    meminfo(20000000);
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: '127.0.0.1',
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_MEMINFO: join(tmpDir, 'meminfo'),
        HARBOR_WB_RESTART_ALL_GAP_MS: '1500',
      }),
    });
    engine.stdout.on('data', (d) => (engineLog += d));
    engine.stderr.on('data', (d) => (engineLog += d));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(250);
      up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) {
      throw new Error(`engine did not come up\n${engineLog}`);
    }
    cookie = await windowCookie(BASE, TOKEN);
    /* live rows seeded before boot are reconciled away at boot; the lead and one member are live from here on */
    await seed({ sessions: [sess(1, 'boss', 'live'), sess(1, 'worker', 'live'), sess(1, 'mem', 'live')] });

    const say = (text, extra = {}) => call(`/api/rooms/${room.id}/line`, { json: { text, ...extra } });
    const asBoss = (text, extra = {}) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:boss#1' }, ...extra }, as: 'agent' });
    const asWorker = (text, extra = {}) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:worker#1' }, ...extra }, as: 'agent' });
    const lines = async () => (await call(`/api/rooms/${room.id}/line?limit=200`)).body?.entries ?? [];
    const meta = (e) => { try { return e?.meta ? JSON.parse(e.meta) : {}; } catch { return {}; } };
    const handles = (r) => (r.body?.deliveries ?? []).map((d) => d.handle).sort().join(',');
    const entry = (r) => r.body?.entries?.find((e) => e.kind === 'chat');

    console.log('\n[a reply to a ROOM line (a fact) with no @ reaches nobody new]');
    const fact = (await lines()).find((e) => e.kind === 'fact');
    ok(!!fact, `there is a room fact to reply to (#${fact?.id})`);
    const r1 = await asBoss('`worker` boss: all quiet on my side', { reply_to: fact.id });
    eq(r1.body?.status, 'posted', 'the agent reply is posted');
    ok(handles(r1) === '' && entry(r1)?.target == null, `delivered to nobody (target ${entry(r1)?.target}, deliveries ${handles(r1) || 'none'})`);
    ok(meta(entry(r1)).to_user !== true, 'and it is NOT marked as to the person');
    ok(meta(entry(r1)).reply?.id === fact.id, 'the reply reference is kept');
    ok(typeof r1.body?.notice === 'string' && r1.body.notice.includes(`#${entry(r1).id}`) && /reached no one/.test(r1.body.notice) && /START of the line/.test(r1.body.notice), `the sender is told in the same answer that line #${entry(r1)?.id} reached no one, and how to fix it: "${(r1.body?.notice ?? '').slice(0, 90)}…"`);
    const r1b = await say('good', { reply_to: fact.id });
    ok(handles(r1b).includes('boss'), "the PERSON's un-addressed reply to a fact still goes to the lead");

    console.log('\n[a reply to a seat\'s line goes to that seat only]');
    const bossLine = await asBoss('@worker take the migration, and ask @mem for the schema');
    const bl = entry(bossLine);
    ok(handles(bossLine) === 'mem,worker', `the original reaches who it names (${handles(bossLine)})`);
    const r2 = await asWorker('on it, thanks', { reply_to: bl.id });
    ok(handles(r2) === 'boss' && entry(r2)?.target === 'boss', `no leading @: only the author of the line it answers (${handles(r2)})`);
    ok(meta(entry(r2)).to_user !== true, '...and not marked to the person');
    ok(!handles(r2).includes('mem'), 'an @ that sat in the QUOTED line (@mem) delivers to no one');
    ok(r2.body?.notice === undefined, 'a reply that reached someone carries no notice');

    console.log('\n[a reply is addressed by its LEADING @ list only (Owner [ref])]');
    const r3 = await asWorker('done, @mem please review', { reply_to: bl.id });
    ok(handles(r3) === 'boss', `an @ in the MIDDLE of a reply delivers to no one new; it goes to the author of the line it answers (${handles(r3)})`);
    const r3b = await asWorker('@mem please review the migration', { reply_to: bl.id });
    ok(handles(r3b) === 'mem', `the same name at the START: only that seat is alerted, not the author of the line (${handles(r3b)})`);
    const r3c = await asWorker('@mem @boss both of you, please', { reply_to: bl.id });
    ok(handles(r3c) === 'boss,mem', `several names at the start all get it (${handles(r3c)})`);
    /* the forward: the quoted line named worker and mem; the reply drops both and names only boss */
    const r3d = await asWorker('@boss only you', { reply_to: bl.id });
    ok(handles(r3d) === 'boss', `the line replied to named worker and mem; the reply names only boss: only boss is alerted (${handles(r3d)})`);
    const r3e = await asWorker('nobody named here', { reply_to: bl.id });
    ok(handles(r3e) === 'boss', `the same reply naming nobody: only the author of the line replied to (${handles(r3e)})`);
    const r3f = await asWorker('see you @user in the middle of a reply', { reply_to: bl.id });
    ok(meta(entry(r3f)).to_user !== true && handles(r3f) === 'boss', 'a mid-text @owner in a reply does not flag it to the person');
    const r3g = await asWorker('@user leading is fine', { reply_to: bl.id });
    ok(meta(entry(r3g)).to_user === true, 'a LEADING @owner in a reply does');

    console.log('\n[a reply that NAMES seats the leading list does not address tells the sender (item 2)]');
    ok(typeof r3.body?.notice === 'string' && /@mem/.test(r3.body.notice) && /START of the line/.test(r3.body.notice) && !/reached no one/.test(r3.body.notice), `a name in the middle is dropped, and the sender is told which: "${(r3.body?.notice ?? '').slice(0, 110)}"`);
    ok(r3b.body?.notice === undefined && r3c.body?.notice === undefined && r3e.body?.notice === undefined, 'names that lead, and a reply naming nobody, carry no such notice');
    const r3h = await asWorker('@user here is the plan for the day.\n- @mem do x\n- @boss do y', { reply_to: bl.id });
    ok(meta(entry(r3h)).to_user === true && handles(r3h) === '', `a reply that leads with @owner reaches the person only (${handles(r3h) || 'no seat'})`);
    ok(typeof r3h.body?.notice === 'string' && /@mem/.test(r3h.body.notice) && /@boss/.test(r3h.body.notice), 'and the notice names both seats it did not reach');
    const r3i = await asWorker('see you @user and `@mem`', { reply_to: bl.id });
    ok(r3i.body?.notice === undefined, 'the person mid-text, and a backticked name, are not dropped seats');
    const r3j = await asWorker('plain line, @mem hello');
    ok(handles(r3j).includes('mem') && r3j.body?.notice === undefined, 'a NEW line is addressed by every @, so nothing is dropped and no notice');

    console.log('\n[a code span or a quote does not address]');
    const r4 = await asWorker('see `@mem` and the line above', { reply_to: bl.id });
    ok(!handles(r4).includes('mem') && handles(r4) === 'boss', `a backticked @mem is not an address (${handles(r4)})`);

    console.log('\n[the person\'s own line and a new line are as before]');
    const mine = await say('@worker what is the status?');
    const mineE = entry(mine);
    const r5 = await asWorker('all green', { reply_to: mineE.id });
    ok(meta(entry(r5)).to_user === true, 'a reply to the PERSON\'s line, naming nobody, is still to the person');
    const r5b = await asWorker('@boss take this one', { reply_to: mineE.id });
    ok(meta(entry(r5b)).reply?.user === true && meta(entry(r5b)).to_user !== true && handles(r5b) === 'boss' && entry(r5b)?.target === 'boss', `a reply to the PERSON's line that names only boss is a forward: reply.user stays as context, but it is not to the person and goes to boss only (${handles(r5b)})`);
    const r6 = await asWorker('`boss` worker: a fresh status line that names nobody');
    ok(meta(entry(r6)).to_user === true, 'a NEW agent line that names nobody is still to the person (the Oct 21 rule)');
    ok(r6.body?.notice === undefined, '...and it reached the person, so no notice');
    const r8 = await asWorker('still nothing named here', { reply_to: fact.id });
    ok(typeof r8.body?.notice === 'string', 'a second dead line gets its notice in the answer too (the fabric copy is limited to one per 20 s)');
    const r7 = await asWorker('@user a note for you', {});
    ok(meta(entry(r7)).to_user === true, 'a line that names the person is to the person');

    console.log('\n[agents get the line number, not the quote]');
    const { replyPrefix } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'engine', 'room-reply.ts')).href);
    ok(replyPrefix(meta(entry(r2)).reply) === '\u21a9 re #' + bl.id + ' @boss', `the prefix is "↩ re #N @author": "${replyPrefix(meta(entry(r2)).reply)}"`);
    ok(await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), 'the engine is still up');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows: the killed engine may still hold the db (EPERM) */ }
  }
  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-40).join('\n'));
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
run();
