/**
 * MCP indicator, ENGINE wiring (ticket): synthetic Claude Code hook POSTs to
 * the real /api/claude-hook sink of a real engine produce `pane.mcp` frames on
 * a socket attached to the pane whose table row banks that session_id, and
 * `pane.ready` carries the calls still in flight. The module's rules are unit-
 * tested in mcp-calls.test.ts; this proves the seams:
 *   - hooks arrive the way the proposed hooks send them: loopback, NO bearer
 *     (auth.isLocalHookDelivery);
 *   - unmatched session and non-MCP tools: 200, matched null, no frame;
 *   - start -> end ok / error failed / error isError, to every viewer;
 *   - pane.ready (a second viewer attaching) carries the open starts;
 *   - Stop ends the main-thread call only; SubagentStop ends the sub-agent's;
 *   - an over-cap body is answered (200), never hangs the hook;
 *   - killing the pane ends its open call warn/interrupted BEFORE pane.exit;
 *   - no tool input / output / error text in any frame or engine log line.
 * A bash recipe (vendor cli-manager) is used on purpose: a claude-code recipe
 * would launch the REAL claude on this host. Its row's session_id is banked
 * straight into the scratch table (WAL; the engine reads it per hook).
 *
 * SAFETY: scratch engine P(98) + live scratch broker P(99), temp table,
 * childEnv(), NATS + fabric off; never :7420/:7430/:8200/:8201/:8204. The
 * temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(98);
const BROKER_PORT = P(99);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'mcp-indicator-test-token';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });
const SID = 'mcp-test-session-5d1c';
const SECRET = 'SECRET-TOOL-TEXT-91be';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { json } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const init = { method: json === undefined ? 'GET' : 'POST', headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Exactly what a hook does: loopback, no bearer, no forwarding header. */
async function hook(body) {
  const res = await fetch(`${BASE}/api/claude-hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function client() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const log = [];
  const waiters = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    log,
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
  };
}

const mcpFrame = (id, phase) => (m) => m.type === 'pane.mcp' && m.id === id && m.phase === phase;
const pre = (id, tool, extra = {}) => ({
  session_id: SID,
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_use_id: id,
  tool_input: { query: SECRET },
  ...extra,
});

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'mcp-indicator.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-mcp-indicator-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  let pane = null;
  let c1 = null;
  let c2 = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const kill = async (proc, signal = 'SIGTERM') => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill(signal);
      await Promise.race([gone, sleep(3000)]);
    }
  };
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) {
      throw new Error(`broker did not come up\n${log}`);
    }
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
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) {
      throw new Error(`engine did not come up\n${log}`);
    }
    console.log(`scratch engine :${PORT}, scratch broker :${BROKER_PORT}`);

    console.log('\n[a pane whose row banks the session id]');
    const recipe = (await call('/api/recipes', { json: { name: 'MCP Shell', target: 'local', projectDir: tmpDir, vendor: 'cli-manager' } })).body?.recipe;
    ok(!!recipe?.id, 'a bash recipe');
    pane = `recipe:${recipe.id}`;
    c1 = client();
    ok(await c1.open(), 'a window opens /pty');
    c1.send({ type: 'attach', paneid: pane, recipe: recipe.id });
    const ready1 = await c1.wait((m) => m.type === 'pane.ready' && m.paneid === pane, 12000);
    ok(!!ready1, 'it spawns a real pty (pane.ready)');
    eq(ready1?.mcp, [], 'a fresh pane.ready carries mcp: []');
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    db.prepare('UPDATE sessions SET session_id=? WHERE paneid=?').run(SID, pane);
    db.close();
    const row = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === pane);
    eq(row?.session_id, SID, 'the row banks the session id');

    console.log('\n[ignored: unmatched session, non-MCP tool]');
    let r = await hook({ ...pre('u0', 'mcp__fabric__send'), session_id: 'no-such-session' });
    eq([r.status, r.body?.matched], [200, null], 'unmatched session -> 200, matched null');
    r = await hook(pre('b0', 'Bash'));
    eq([r.status, r.body?.matched], [200, null], 'a non-MCP tool on a matched session -> 200, matched null');
    await sleep(300);
    ok(!c1.log.some((m) => m.type === 'pane.mcp'), 'neither produced a pane.mcp frame');

    console.log('\n[start -> ok]');
    r = await hook(pre('t1', 'mcp__sample-docs__search'));
    eq([r.status, r.body?.matched], [200, pane], 'PreToolUse -> 200, matched the pane (no bearer: loopback exemption)');
    const s1 = await c1.wait(mcpFrame('t1', 'start'));
    ok(!!s1, 'pane.mcp start arrives on the pane socket');
    eq(Object.keys(s1 ?? {}).sort(), ['caller', 'id', 'label', 'paneid', 'phase', 'server', 'ts', 'type', 'verb'], 'start frame fields, exactly');
    eq([s1?.paneid, s1?.server, s1?.label, s1?.verb, s1?.caller], [pane, 'sample-docs', 'sample-docs', 'search', { kind: 'agent', name: 'agent' }], 'server, label, verb, caller');
    ok(Number.isFinite(s1?.ts) && Math.abs(Date.now() - s1.ts) < 60000, 'ts is epoch ms');
    await hook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__sample-docs__search', tool_use_id: 't1', tool_input: { query: SECRET }, tool_response: { content: [{ type: 'text', text: SECRET }] } });
    const e1 = await c1.wait(mcpFrame('t1', 'end'));
    eq([e1?.result, e1?.why, typeof e1?.ms, e1?.label, e1?.verb], ['ok', undefined, 'number', 'sample-docs', 'search'], 'PostToolUse -> end ok with ms, no why');

    console.log('\n[failed, isError]');
    await hook(pre('t2', 'mcp__example-tools__run_command'));
    await hook({ session_id: SID, hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__example-tools__run_command', tool_use_id: 't2', tool_input: { cmd: SECRET }, error: SECRET, is_interrupt: false });
    const e2 = await c1.wait(mcpFrame('t2', 'end'));
    eq([e2?.result, e2?.why, e2?.label], ['error', 'failed', 'example-tools'], 'PostToolUseFailure -> error/failed');
    await hook(pre('t3', 'mcp__claude_ai_Claude_Docs__batch'));
    await hook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__claude_ai_Claude_Docs__batch', tool_use_id: 't3', tool_response: { isError: true, content: [{ type: 'text', text: SECRET }] } });
    const e3 = await c1.wait(mcpFrame('t3', 'end'));
    eq([e3?.result, e3?.why, e3?.label], ['error', 'isError', 'Claude Docs'], 'PostToolUse with isError -> error/isError');

    console.log('\n[two live rows bank one session id: the end reaches the pane holding the start]');
    const recipeB = (await call('/api/recipes', { json: { name: 'MCP Shell B', target: 'local', projectDir: tmpDir, vendor: 'cli-manager' } })).body?.recipe;
    const paneB = `recipe:${recipeB?.id}`;
    const cb = client();
    ok(await cb.open(), 'a window on a second pane');
    cb.send({ type: 'attach', paneid: paneB, recipe: recipeB?.id });
    ok(!!(await cb.wait((m) => m.type === 'pane.ready' && m.paneid === paneB, 12000)), 'the second pane spawns');
    /* Far-future updated_at so the engine's own writes cannot reorder the rows. */
    const bank = (p, sid, at) => {
      const d = new Database(dbPath);
      d.pragma('busy_timeout = 3000');
      d.prepare('UPDATE sessions SET session_id=?, updated_at=? WHERE paneid=?').run(sid, at, p);
      d.close();
    };
    bank(pane, SID, Date.now() + 1e9);
    bank(paneB, SID, 1);
    r = await hook(pre('dup1', 'mcp__fabric__send'));
    eq(r.body?.matched, pane, 'row A is the newest: the sink matches A');
    const sd = await c1.wait(mcpFrame('dup1', 'start'));
    eq(sd?.paneid, pane, 'the start lands on pane A');
    bank(paneB, SID, Date.now() + 2e9);
    r = await hook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__fabric__send', tool_use_id: 'dup1', tool_response: {} });
    eq(r.body?.matched, paneB, 'a reorder mid-call: the sink now matches row B');
    const ed = await c1.wait(mcpFrame('dup1', 'end'));
    eq([ed?.paneid, ed?.result], [pane, 'ok'], 'the end still reaches pane A, where its start is');
    ok(!cb.log.some((m) => m.type === 'pane.mcp'), 'pane B never showed it');
    bank(paneB, null, 1);
    cb.send({ type: 'kill', paneid: paneB });
    await cb.wait((m) => m.type === 'pane.exit' && m.paneid === paneB, 8000);
    cb.close();

    console.log('\n[pane.ready carries the calls still in flight]');
    await hook(pre('m1', 'mcp__fabric__send'));
    await hook(pre('s1', 'mcp__sample-host__exec', { agent_id: 'agent-1', agent_type: 'Explore' }));
    await c1.wait(mcpFrame('s1', 'start'));
    c2 = client();
    ok(await c2.open(), 'a second window opens /pty');
    c2.send({ type: 'attach', paneid: pane, recipe: recipe.id, intent: 'view' });
    const ready2 = await c2.wait((m) => m.type === 'pane.ready' && m.paneid === pane, 8000);
    eq(ready2?.mcp?.map((x) => [x.type, x.phase, x.id, x.caller.kind, x.caller.name]), [
      ['pane.mcp', 'start', 'm1', 'agent', 'agent'],
      ['pane.mcp', 'start', 's1', 'sub', 'Explore'],
    ], 'the reattach pane.ready carries both open starts, oldest first');
    ok(ready2?.mcp?.every((x) => Number.isFinite(x.ts)), 'with their original ts');

    console.log('\n[Stop: main thread only; SubagentStop: that agent]');
    await hook({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: SECRET });
    const em = await c1.wait(mcpFrame('m1', 'end'));
    eq([em?.result, em?.why], ['warn', 'interrupted'], 'Stop ends the main-thread call warn/interrupted');
    ok(!!(await c2.wait(mcpFrame('m1', 'end'), 3000)), 'every viewer gets it');
    await sleep(300);
    ok(!c1.log.some(mcpFrame('s1', 'end')), "the sub-agent's call is still open after Stop");
    await hook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'Explore', last_assistant_message: SECRET });
    const es = await c1.wait(mcpFrame('s1', 'end'));
    eq([es?.result, es?.why, es?.caller], ['warn', 'interrupted', { kind: 'sub', name: 'Explore' }], 'SubagentStop ends it');

    console.log('\n[Esc delivers no end: Notification idle_prompt ends the main thread]');
    await hook(pre('esc1', 'mcp__sample-host__exec'));
    await c1.wait(mcpFrame('esc1', 'start'));
    await hook({ session_id: SID, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: SECRET });
    await sleep(300);
    ok(!c1.log.some(mcpFrame('esc1', 'end')), 'a permission_prompt Notification ends nothing');
    r = await hook({ session_id: SID, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    eq(r.body?.matched, pane, 'the idle_prompt Notification matches through the existing sink');
    {
      /* The idle nag after a finished turn must leave the pane idle (a real
         permission prompt above correctly made it 'waiting'). */
      await hook({ session_id: SID, hook_event_name: 'Stop' });
      await hook({ session_id: SID, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
      const act = await call('/api/diag/activity');
      const p = (act.body?.panes ?? []).find((x) => x.paneid === pane);
      ok(!!p && p.state !== 'waiting', `the idle nag does not park the pane in waiting (typed room delivery needs idle; got ${p?.state})`);
    }
    const eEsc = await c1.wait(mcpFrame('esc1', 'end'));
    eq([eEsc?.result, eEsc?.why], ['warn', 'interrupted'], 'and ends the call warn/interrupted');

    console.log('\n[an over-cap body is answered, not hung]');
    const big = JSON.stringify({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__fabric__send', tool_use_id: 'big', tool_response: 'x'.repeat(2.5 * 1024 * 1024) });
    const t0 = Date.now();
    r = await hook(big);
    eq([r.status, r.body?.matched], [200, null], 'a 2.5 MB hook body -> 200, matched null (the sink never errors a hook)');
    ok(Date.now() - t0 < 5000, `answered in ${Date.now() - t0} ms`);

    console.log('\n[flood bound: an unauthenticated flood reaches a window at most one burst deep]');
    const floodIds = Array.from({ length: 80 }, (_, i) => `flood${i}`);
    await Promise.all(floodIds.map((id) => hook(pre(id, 'mcp__fabric__send'))));
    await Promise.all(floodIds.map((id) => hook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__fabric__send', tool_use_id: id, tool_response: {} })));
    await sleep(400);
    const floodStarts = c1.log.filter((m) => m.type === 'pane.mcp' && m.phase === 'start' && m.id.startsWith('flood')).length;
    const floodEnds = c1.log.filter((m) => m.type === 'pane.mcp' && m.phase === 'end' && m.id.startsWith('flood')).length;
    ok(floodStarts > 0 && floodStarts <= 32 && floodEnds === floodStarts, `80 start+end pairs -> ${floodStarts} starts / ${floodEnds} ends reach the window (<= the 32 burst; an unadmitted start's end is dropped)`);
    ok((log.match(/dropped [0-9]+ start/g) ?? []).length === 1, 'the drops are ONE engine log line');
    await sleep(600); // let the bucket refill before the next case

    console.log('\n[pane end ends its open calls]');
    await hook(pre('k1', 'mcp__sample-task-mcp__get_task'));
    await c1.wait(mcpFrame('k1', 'start'));
    c1.send({ type: 'kill', paneid: pane });
    const ek = await c1.wait(mcpFrame('k1', 'end'));
    const exit = await c1.wait((m) => m.type === 'pane.exit' && m.paneid === pane);
    eq([ek?.result, ek?.why, ek?.label], ['warn', 'interrupted', 'sample-task-mcp'], 'killing the pane ends k1 warn/interrupted');
    ok(!!exit && c1.log.indexOf(ek) < c1.log.indexOf(exit), 'before pane.exit');
    pane = null;
    r = await hook({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'mcp__sample-task-mcp__get_task', tool_use_id: 'k1', tool_response: {} });
    eq(r.body?.matched, null, 'after the pane ended its session no longer matches');
    const late = client();
    ok(await late.open(), 'a window that slept through the end reconnects');
    late.send({ type: 'attach', paneid: exit.paneid, recipe: recipe.id, intent: 'reclaim' });
    const nl = await late.wait((m) => (m.type === 'pane.needs-launch' || m.type === 'pane.ready') && m.paneid === exit.paneid, 8000);
    eq([nl?.type, nl?.mcp], ['pane.needs-launch', []], 'it is refused with pane.needs-launch carrying mcp: [] (drop any chips still shown)');
    late.close();

    console.log('\n[privacy]');
    const frames = [...c1.log, ...c2.log].filter((m) => m.type === 'pane.mcp' || m.type === 'pane.ready');
    ok(frames.length >= 12, `${frames.length} pane.mcp/pane.ready frames seen`);
    ok(!JSON.stringify(frames).includes(SECRET), 'no tool input / output / error text in any frame');
    ok(!log.includes(SECRET), 'none in the engine log either');
    ok(log.includes('mcp: 1 in-flight call(s) on recipe:') && log.includes('ended interrupted (Stop)'), 'the log carries counts');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
    console.log(`--- engine/broker log tail ---\n${log.slice(-2500)}`);
  } finally {
    c2?.close();
    if (engine && pane) {
      const c = client();
      if (await c.open()) {
        c.send({ type: 'attach', paneid: pane, intent: 'reclaim' });
        await c.wait((m) => m.type === 'pane.control' && m.controlling === true, 4000);
        c.send({ type: 'kill', paneid: pane });
        await c.wait((m) => m.type === 'pane.exit' && m.paneid === pane, 4000);
        c.close();
      }
    }
    c1?.close();
    await kill(engine);
    await kill(broker);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
