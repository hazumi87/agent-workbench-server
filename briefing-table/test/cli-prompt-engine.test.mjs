/**
 * THE CLI PROMPT END TO END (the design notes): a starter seat starts through a real local engine and a real scratch broker;
 * the "claude" on its PATH is a script that draws the trust prompt and waits. The prompt must show on the pane's table row, on the seat's
 * roster entry, and ONCE as a room fact; and when a screen the detector cannot tell yet is the only thing drawn, no claim is made.
 * SAFETY: Linux only; LIVE scratch broker P(559); the engine on port 0; temp folders; never :7420/:7430/:8200/:8201/:8204.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('cli-prompt-engine.test: Linux only - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROKER_PORT = P(559);
const HOST = '127.0.0.1';
const TOKEN = 'cli-prompt-engine-token';
const LF = String.fromCharCode(10);
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
function ok(c, m, got) {
  if (c) {
    passed++;
    console.log(`  + ${m}`);
  } else {
    failed++;
    console.log(`  X ${m}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

async function run() {
  await assertFree(BROKER_PORT, 'cli-prompt-engine.test.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-cli-prompt-engine-'));
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  /* the fake "claude": clear the screen, draw the trust prompt, wait */
  const bin = join(tmpDir, 'bin');
  mkdirSync(bin, { recursive: true });
  const trustText = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'cli-prompts', 'trust.txt'), 'utf8');
  const LINK = 'https://claude.ai/oauth/authorize?code=true&client_id=test-client-0000&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=SECRETSTATE123456789';
  const loginText = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'cli-prompts', 'login-code.txt'), 'utf8').replace(/https:\/\/\S+/, LINK);
  const flag = join(tmpDir, 'login.flag');
  const exitFlag = join(tmpDir, 'exit.flag');
  writeFileSync(join(bin, 'claude'), `#!/bin/bash${LF}printf '\\033[2J\\033[H'${LF}if [ -f '${exitFlag}' ]; then exit 1; fi${LF}if [ -f '${flag}' ]; then${LF}cat <<'EOT'${LF}${loginText}${LF}EOT${LF}else${LF}cat <<'EOT'${LF}${trustText}${LF}EOT${LF}fi${LF}sleep 600${LF}`);
  chmodSync(join(bin, 'claude'), 0o755);
  mkdirSync(join(tmpDir, 'files', 'agents', 'lead'), { recursive: true });
  mkdirSync(join(tmpDir, 'files', 'agents', 'builder'), { recursive: true });
  const PATH = `${bin}:${process.env.PATH}`;
  let broker = null;
  let engine = null;
  let port = 0;
  let out = '';
  let log = ''; // stdout AND stderr: the engine's whole log
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: { ...childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }), PATH } });
    broker.stdout.on('data', () => {});
    broker.stderr.on('data', () => {});
    ok(await until(() => fetch(`http://${HOST}:${BROKER_PORT}/health`).then((r) => r.status < 500).catch(() => false), 30000), 'a LIVE scratch broker is up');
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: {
        ...childEnv({
          HARBOR_WB_MODE: 'local',
          HARBOR_WB_TOKEN: TOKEN,
          HARBOR_WB_DATA_DIR: join(tmpDir, 'data'),
          HARBOR_WB_FILES_DIR: join(tmpDir, 'files'),
          HARBOR_WB_MEMORY_CEILING_MB: '0',
          HARBOR_WB_SEAT_WELCOME: '0',
          HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
          HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
          HARBOR_WB_NODE: 'testnode',
          HARBOR_WB_TARGETS: TARGETS,
          HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
          HARBOR_WB_CLI_PROMPT_SWEEP_MS: '500',
          HARBOR_WB_SHELL_PROMPT_S: '2',
          HARBOR_WB_VSCREEN_SETTLE_MS: '200',
          CLAUDE_CONFIG_DIR: join(tmpDir, 'claude-config'),
        }),
        PATH,
      },
    });
    engine.stdout.on('data', (d) => { out += d; log += d; });
    engine.stderr.on('data', (d) => (log += d)); // the engine's whole log: nothing secret may be in it
    for (let t = 0; t < 60000 && !port; t += 200) {
      await sleep(200);
      try {
        port = JSON.parse(out.split(LF)[0]).port;
      } catch {
        /* not yet */
      }
    }
    ok(port > 0, 'the local engine is up (no HARBOR_WB_VSCREEN set: the screen model is on by default locally)');
    const base = `http://${HOST}:${port}`;
    const cookie = await windowCookie(base, TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const http = async (path, { json, headers = auth } = {}) => {
      const init = { method: json === undefined ? 'GET' : 'POST', headers: { ...headers } };
      if (json !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const seeded = await http('/api/local/seed', { json: { template: 'my-first-room', version: 1 } });
    const seatId = seeded.body?.seats?.planner;
    ok(seeded.status === 201 && !!seatId, 'the starter room is seeded', seeded.status);
    const started = await http(`/api/rooms/${seeded.body.room_id}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(started.status === 200 && typeof started.body?.paneid === 'string', `the starter seat starts (${started.status} ${started.body?.error ?? ''})`, started.status);
    const paneid = started.body?.paneid;

    const rowOf = async () => {
      const t = await http('/api/table');
      const rows = Array.isArray(t.body) ? t.body : (t.body?.sessions ?? t.body?.rows ?? []);
      return rows.find((r) => r.paneid === paneid);
    };
    console.log('\n[the table row]');
    const row = await until(async () => {
      const r = await rowOf();
      return r?.cliPrompt === 'trust' ? r : null;
    }, 30000);
    ok(!!row, 'the pane\'s table row says cliPrompt "trust"', (await rowOf())?.cliPrompt);
    ok(row?.cliPromptReason === null, '...with no reason (a name carries none)', row?.cliPromptReason);

    console.log('\n[the roster]');
    const detail = await http(`/api/rooms/${seeded.body.room_id}`, { headers: { cookie } });
    const seat = (detail.body?.seats ?? []).find((s) => s.id === seatId || s.handle === 'planner');
    const occ = seat?.occupant ?? {};
    ok(occ.cli_prompt === 'trust' && occ.waiting_at === 'folder trust', 'the seat\'s occupant carries cli_prompt "trust" and waiting_at "folder trust"', { cli_prompt: occ.cli_prompt, waiting_at: occ.waiting_at });

    console.log('\n[the room fact, once]');
    const factCount = async () => {
      const l = await http(`/api/rooms/${seeded.body.room_id}/line?limit=200`, { headers: { cookie } });
      return (l.body?.entries ?? []).filter((e) => e.kind === 'fact' && e.body === '@planner is waiting at a CLI prompt: folder trust').length;
    };
    ok(await until(async () => (await factCount()) >= 1, 15000), 'a fact says "@planner is waiting at a CLI prompt: folder trust"');
    await sleep(2500); // several sweeps at 500 ms
    ok((await factCount()) === 1, 'and it is said ONCE, not per sweep', await factCount());

    console.log('\n[folder trust (E3): written right before the launch, read back, said once]');
    const cfg = JSON.parse(readFileSync(join(tmpDir, 'claude-config', '.claude.json'), 'utf8'));
    const lead = join(tmpDir, 'files', 'agents', 'lead');
    ok(cfg.projects?.[lead]?.hasTrustDialogAccepted === true, 'the seat\'s folder is marked trusted in .claude.json', Object.keys(cfg.projects ?? {}));
    const trustFacts = async () => {
      const l = await http(`/api/rooms/${seeded.body.room_id}/line?limit=200`, { headers: { cookie } });
      return (l.body?.entries ?? []).filter((e) => e.kind === 'fact' && e.body === `@planner's folder is trusted (${lead})`).length;
    };
    ok((await trustFacts()) === 1, 'the room says so once, after the read-back');

    console.log('\n[the sign-in link: one authenticated route, and nowhere else]');
    writeFileSync(flag, '1');
    const builderId = seeded.body?.seats?.builder;
    const st2 = await http(`/api/rooms/${seeded.body.room_id}/seats/${builderId}/start`, { json: {}, headers: { cookie } });
    ok(st2.status === 200, `a second seat starts, its claude draws the login prompt (${st2.status})`, st2.status);
    const pane2 = st2.body?.paneid;
    const row2 = await until(async () => {
      const t = await http('/api/table');
      const rows = Array.isArray(t.body) ? t.body : (t.body?.sessions ?? t.body?.rows ?? []);
      const r = rows.find((x) => x.paneid === pane2);
      return r?.cliPrompt === 'login' ? r : null;
    }, 30000);
    ok(!!row2, 'its row says cliPrompt "login"');
    ok(row2?.cliPromptLink === true, 'and cliPromptLink is true: a link is available (the boolean, not the link)', row2?.cliPromptLink);
    const tableText = JSON.stringify((await http('/api/table')).body);
    ok(!tableText.includes('SECRETSTATE') && !tableText.includes('oauth/authorize'), 'the link is NOT in the polled table');
    const got = await http(`/api/panes/${encodeURIComponent(pane2)}/sign-in-link`, { headers: { cookie } }); // the link is for the signed-in PERSON only
    ok(got.status === 200 && got.body?.link === LINK, 'GET /api/panes/:paneid/sign-in-link returns the whole link, wrapped rows rejoined', got.body);
    ok((await http(`/api/panes/${encodeURIComponent(pane2)}/sign-in-link`, { headers: {} })).status === 401, 'no credential: 401');
    ok((await http(`/api/panes/${encodeURIComponent(pane2)}/sign-in-link`)).status === 403, 'an agent credential (the bearer) is refused: 403 person_only');
    ok((await http(`/api/panes/${encodeURIComponent(paneid)}/sign-in-link`, { headers: { cookie } })).status === 404, 'a pane that is not at the login prompt has none: 404');
    await sleep(2500);
    const lines = await http(`/api/rooms/${seeded.body.room_id}/line?limit=500`, { headers: { cookie } });
    ok(!JSON.stringify(lines.body).includes('SECRETSTATE'), 'the link is in no room line');
    ok(log.length > 0 && !log.includes('SECRETSTATE') && !log.includes('oauth/authorize'), 'the link is in nothing the engine logged', log.split(LF).filter((l) => l.includes('oauth')).slice(0, 1));
    const diag = JSON.stringify((await http('/api/diag/vscreen')).body ?? {});
    ok(!diag.includes('SECRETSTATE'), 'and not in the screen model\'s diagnostics');
    await http(`/api/sessions/${encodeURIComponent(pane2)}/end`, { json: {}, headers: { cookie } });

    console.log('\n[the voice send seam (POST /api/concierge/send), through the real engine]');
    const send = (b, headers = auth) => http('/api/concierge/send', { json: b, headers });
    const U = (n) => `agent-voice-17300000000${n}-ab12`;
    ok((await send({ text: 'hi' })).body?.field === 'utteranceId', 'no utteranceId: 400 bad-field');
    ok((await send({ text: 'a\u0001b', utteranceId: U(1) })).body?.error === 'control-character', 'a control character: 400 control-character');
    const tooLong = await send({ text: 'x'.repeat(2000), utteranceId: U(2) });
    ok(tooLong.status === 413 && tooLong.body?.error === 'too-long' && tooLong.body?.limit > 1000 && tooLong.body?.limit < 2000 && tooLong.body?.length === 2000, 'over the typer\'s limit: 413 too-long with the real limit (not 2000)', tooLong.body);
    ok((await send({ text: 'hi', utteranceId: U(3) }, {})).status === 401, 'no credential: 401');
    const off = await send({ text: 'hello there', utteranceId: U(4) });
    ok(off.status === 409 && off.body?.error === 'no-channel', 'the Concierge is not turned on: 409 no-channel', off.body);
    const patched = await fetch(`${base}/api/concierge`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, primary: 'starter-builder' }) });
    ok(patched.status === 200, `the person turns the Concierge on (${patched.status})`, patched.status);
    const noPane = await send({ text: 'hello there', utteranceId: U(5) });
    ok(noPane.status === 409 && noPane.body?.error === 'no-channel', 'turned on but its pane is not running: still 409 no-channel', noPane.body);

    console.log('\n[a lead whose agent is not running: a bare shell is its own state and its own sentence]');
    unlinkSync(flag);
    writeFileSync(exitFlag, '1');
    const g = await http('/api/local/seed', { json: { template: 'my-project', version: 3 } });
    const leadSeat = g.body?.seats?.['project-lead'];
    const stL = await http(`/api/rooms/${g.body.room_id}/seats/${leadSeat}/start`, { json: {}, headers: { cookie } });
    ok(stL.status === 200, `the starter lead starts (${stL.status} ${stL.body?.error ?? ''})`, stL.status);
    const paneL = stL.body?.paneid;
    const rowL = await until(async () => {
      const t = await http('/api/table');
      const rows = Array.isArray(t.body) ? t.body : (t.body?.sessions ?? t.body?.rows ?? []);
      const r = rows.find((x) => x.paneid === paneL);
      return r?.cliPrompt === 'shell' ? r : null;
    }, 30000);
    ok(!!rowL, 'its table row says cliPrompt "shell" once the claude line has ended at the prompt', null);
    ok(rowL?.cliPromptReason === null, '...with no reason');
    const detL = await http(`/api/rooms/${g.body.room_id}`, { headers: { cookie } });
    const occL = (detL.body?.seats ?? []).find((s) => s.id === leadSeat)?.occupant ?? {};
    ok(occL.cli_prompt === 'shell' && occL.waiting_at === undefined, 'the roster says shell and carries NO "waiting_at" (it is not an agent waiting)', { cli_prompt: occL.cli_prompt, waiting_at: occL.waiting_at });
    const factL = async () => {
      const l = await http(`/api/rooms/${g.body.room_id}/line?limit=200`, { headers: { cookie } });
      return (l.body?.entries ?? []).filter((e) => e.kind === 'fact' && e.body === '@project-lead: no agent is running in its terminal').length;
    };
    ok(await until(async () => (await factL()) >= 1, 15000), 'the room says "@project-lead: no agent is running in its terminal"');
    await sleep(2000);
    ok((await factL()) === 1, '...once');
    ok(!(await http(`/api/rooms/${g.body.room_id}/line?limit=200`, { headers: { cookie } })).body.entries.some((e) => /unknown CLI prompt/.test(e.body ?? '')), 'and never "an unknown CLI prompt"');
    await http(`/api/sessions/${encodeURIComponent(paneL)}/end`, { json: {}, headers: { cookie } });

    /* The held / startup / no-claude answers need a running Concierge pane (the primary pane, which only a window attach spawns); they are covered
       with a typer double in test/concierge-send.test.ts. */

    await http(`/api/sessions/${encodeURIComponent(paneid)}/end`, { json: {}, headers: { cookie } });
  } catch (e) {
    failed++;
    console.log(`  X harness: ${e?.stack ?? e}`);
  } finally {
    if (engine && engine.exitCode === null) engine.kill('SIGKILL');
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await sleep(500);
      if (broker.exitCode === null) broker.kill('SIGKILL');
    }
    await sleep(300);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
run();
