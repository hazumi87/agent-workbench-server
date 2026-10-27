/** Owned strict-hosted engine, authenticated scratch broker and inert PTYs only. */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, readlinkSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { tsImport } from 'tsx/esm/api';
import { root, unitDir } from './_hosting-proof.mjs';
import { P, assertFree } from './_scratch.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, name, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(50); }
  throw Error('Positive control timed out: ' + name);
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit'); proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function startTraceFixture() {
  const port = P(2100), brokerPort = P(2101), actualBrokerPort = P(2102);
  for (const n of [port, brokerPort, actualBrokerPort]) {
    if (n >= 8000 && n <= 8999) throw Error('Trace proof refuses live 8xxx port band');
    await assertFree(n, 'W1 terminal trace');
  }
  const dir = join(unitDir, 'w1');
  for (const name of ['home', 'data', 'files', 'agents', 'bin', 'project-a', 'project-b', 'config', 'codex-home', 'claude-projects', 'owned-proc']) mkdirSync(join(dir, name), { recursive: true });
  const binary = join(dir, 'bin', 'claude');
  const inertBinary = join(dir, 'bin', 'receiver', 'claude');
  mkdirSync(dirname(inertBinary), { recursive: true });
  const compiled = spawnSync('cc', ['-O1', '-Wall', '-Wextra', '-o', inertBinary,
    new URL('./fixtures/w1-inert-agent.c', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'home'), LANG: 'C.UTF-8' } });
  if (compiled.status !== 0) throw Error('T1 requires cc to compile the inert REPL fixture');
  // A real root bash remains while the separate native REPL owns its tty.
  // The trailing status command prevents bash's last-command exec elision.
  writeFileSync(binary, '#!/bin/bash\n"' + inertBinary + '" "$@"\nstatus=$?\nexit "$status"\n', { mode: 0o700 });
  const token = randomBytes(32).toString('hex'), brokerToken = randomBytes(32).toString('hex');
  const base = 'http://127.0.0.1:' + port;
  // Tiny allowlist: no ambient credentials, real HOME/config, external broker,
  // fabric, voice or vendor state is inherited by either owned process.
  const common = { PATH: join(dir, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(dir, 'home'), LANG: 'C.UTF-8', TZ: 'UTC', WB_T1_ROOT: dir, WB_T1_BINARY: binary };
  // Explicit diagnostic only: reproduce old delivery on this owned engine.
  // No other ambient environment is inherited, and default stays hosted.
  const delivery = process.env.WB_PROOF_T1_DELIVERY;
  if (delivery !== undefined && !['typed', 'doorbell'].includes(delivery)) throw Error('T1 delivery override must be typed or doorbell');
  const env = { ...common, ...(delivery ? { HARBOR_WB_DELIVERY: delivery } : {}), HARBOR_WB_PORT: String(port), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_HOSTED: '1',
    HARBOR_WB_IDENTITY: 'strict', HARBOR_WB_IDENTITY_DB: join(dir, 'data', 'identity.db'), HARBOR_WB_TOKEN: token,
    HARBOR_WB_TABLE: join(dir, 'data', 'table.db'), HARBOR_WB_DATA_DIR: join(dir, 'data'), HARBOR_WB_FILES_DIR: join(dir, 'files'), HARBOR_WB_FS_ROOT: dir,
    HARBOR_WB_WEBAUTHN_ORIGIN: base, HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_MEMORY_CEILING_MB: '0',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(brokerPort), HARBOR_WB_BROKER_TOKEN: brokerToken,
    HARBOR_WB_BROKERS: '{}', HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Owned T1', kind: 'local', shell: '/bin/sh' }] }),
    HARBOR_WB_PROC_ROOT: join(dir, 'owned-proc'), HARBOR_WB_CLAUDE_PROJECTS: join(dir, 'claude-projects'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CODEX_HOME: join(dir, 'codex-home'),
    HARBOR_WB_PTY_TRACE_TEXT: '1', HARBOR_WB_ROOM_TYPE: '1', HARBOR_WB_ROOM_TYPE_SETTLE_MS: '100', HARBOR_WB_TYPE_ENTER_MS: '20', HARBOR_WB_TYPE_SUBMIT_CHECK_MS: '200', HARBOR_WB_SEAT_WELCOME: '0',
  };
  const loader = join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const seed = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', "import {createAccount} from './src/identity/store.ts'; import {hashPassword} from './src/identity/auth.ts'; createAccount({username:'proof',passwordHash:await hashPassword('Proof-only-scratch!47'),mustChange:false,passwordExpiresAt:null,isAdmin:true});"], { cwd: root, env, stdio: 'ignore' });
  const [seedCode] = await once(seed, 'exit');
  if (seedCode !== 0) throw Error('Owned trace identity seed failed');
  let broker, engine, cookie, ws, proxy, proxyWs, closed = false;
  const panes = new Set(), events = [];
  const brokerInputs = [], brokerSpawnIds = new Set(), relaySockets = new Set();
  const hasOriginTrace = existsSync(join(root, 'src/engine/pty-write.ts'));
  let logs = '';
  const capture = proc => { for (const stream of [proc.stdout, proc.stderr]) stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-24000); }); };
  async function close() {
    if (closed) return; closed = true;
    if (ws?.readyState === WebSocket.OPEN) {
      for (const paneid of panes) ws.send(JSON.stringify({ type: 'kill', paneid }));
      await sleep(200); ws.close();
    }
    await stop(engine);
    for (const socket of relaySockets) socket.terminate();
    if (proxyWs) await new Promise(resolve => proxyWs.close(resolve));
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await stop(broker);
    // Only our fixture children, whose cwd is still an owned project folder.
    for (const f of readdirSync(join(dir, 'agents')).filter(f => f.endsWith('.json'))) {
      const agent = JSON.parse(readFileSync(join(dir, 'agents', f), 'utf8'));
      try {
        const cwd = readlinkSync('/proc/' + agent.pid + '/cwd');
        if (cwd === join(dir, 'project-a') || cwd === join(dir, 'project-b')) process.kill(agent.pid, 'SIGTERM');
      } catch { /* already exited; never signal an unverified PID */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    broker = spawn(process.execPath, ['--import', loader, join(root, 'node_modules/pty-broker/src/main.ts')], { cwd: dir, env: { ...common, PTY_BROKER_PORT: String(actualBrokerPort), PTY_BROKER_HOST: '127.0.0.1', PTY_BROKER_TOKEN: brokerToken }, stdio: ['ignore', 'pipe', 'pipe'] }); capture(broker);
    await until(async () => { if (broker.exitCode !== null) throw Error('Owned broker exited before readiness'); try { return (await fetch('http://127.0.0.1:' + actualBrokerPort + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'scratch broker readiness');
    // Transparent TEST-ONLY relay observes every real broker input frame,
    // including any call path that might bypass the newer origin funnel.
    // It forwards bytes unchanged to this fixture's authenticated broker.
    proxy = createServer(async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404); res.end(); return; }
      const health = await fetch('http://127.0.0.1:' + actualBrokerPort + '/health');
      res.writeHead(health.status, { 'content-type': 'application/json' }); res.end(await health.text());
    });
    proxyWs = new WebSocketServer({ server: proxy, path: '/broker' });
    proxyWs.on('connection', (incoming, req) => {
      if (req.headers.authorization !== 'Bearer ' + brokerToken) { incoming.close(4401); return; }
      const downstream = new WebSocket('ws://127.0.0.1:' + actualBrokerPort + '/broker', { headers: { authorization: 'Bearer ' + brokerToken } });
      const waiting = [];
      relaySockets.add(incoming); relaySockets.add(downstream);
      downstream.on('open', () => { for (const bytes of waiting.splice(0)) downstream.send(bytes); });
      incoming.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'spawn') brokerSpawnIds.add(message.sid);
        if (message.type === 'input') brokerInputs.push({ sid: message.sid, data: message.data, bytes: Buffer.byteLength(message.data), sha256: createHash('sha256').update(message.data).digest('hex') });
        if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes); else waiting.push(Buffer.from(bytes));
      });
      downstream.on('message', bytes => { if (incoming.readyState === WebSocket.OPEN) incoming.send(bytes); });
      incoming.on('error', () => downstream.terminate()); downstream.on('error', () => incoming.terminate());
      incoming.on('close', () => { relaySockets.delete(incoming); downstream.close(); });
      downstream.on('close', () => { relaySockets.delete(downstream); incoming.close(); });
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(brokerPort, '127.0.0.1', resolve); });
    engine = spawn(process.execPath, ['--import', loader, join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); capture(engine);
    await until(async () => { if (engine.exitCode !== null) throw Error('Owned engine exited before readiness'); try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'scratch hosted engine readiness');
    const login = await fetch(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'proof', password: 'Proof-only-scratch!47' }), redirect: 'manual' });
    cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); await login.text();
    if (!cookie) throw Error('Owned person login failed');
    async function request(path, { method = 'GET', value, headers = {}, signedIn = true } = {}) {
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { ...(signedIn ? { cookie } : {}), ...(!['GET','HEAD'].includes(method) ? { origin: base } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      const text = await response.text(); let body; try { body = JSON.parse(text); } catch {}
      return { status: response.status, body };
    }
    ws = new WebSocket(base.replace('http:', 'ws:') + '/pty', { headers: { cookie, origin: base } });
    ws.on('error', () => {});
    ws.on('message', bytes => { try { events.push(JSON.parse(bytes.toString())); } catch {} });
    await once(ws, 'open');
    const send = message => ws.send(JSON.stringify(message));
    async function attach(recipe) {
      const paneid = 'recipe:' + recipe.id + '#t1'; panes.add(paneid);
      send({ type: 'attach', paneid, recipe: recipe.id, spawn: true });
      const result = await until(() => events.find(e => e.paneid === paneid && ['pane.ready','pane.error'].includes(e.type)), 'real inert PTY attach');
      if (result.type !== 'pane.ready' || result.state !== 'live') throw Error('Inert PTY did not become live: ' + (result.message ?? result.state));
      const identity = await until(() => {
        for (const f of readdirSync(join(dir, 'agents')).filter(f => f.endsWith('.json'))) {
          const agent = JSON.parse(readFileSync(join(dir, 'agents', f), 'utf8'));
          if (agent.paneid === paneid) return agent;
        }
      }, 'inert program identity');
      if (identity.script !== inertBinary || identity.vendorBinary !== binary || !identity.sessionId) throw Error('Expected exact inert binary and engine-managed session id');
      if (!brokerSpawnIds.has(paneid)) throw Error('Owned pane must match an actually observed broker spawn SID');
      // pane.ready.sessionId is a display identity (bk:local:<sid>), not
      // the SID carried by the broker's input frame. Use the observed spawn.
      return { paneid, brokerSid: paneid, identity };
    }
    const writes = async () => { if (!hasOriginTrace) return null; const r = await request('/api/diag/pty-writes'); if (r.status !== 200 || !Array.isArray(r.body?.writes)) throw Error('T1 trace seam unavailable despite source capability'); return r.body.writes; };
    function exposeOwnedProcess(agent) {
      // No /proc scan: inspect ONLY the PID reported by our inert child and
      // its controlling-session leader, each verified against our pane/cwd/uid.
      const root = join(dir, 'owned-proc');
      const first = readFileSync('/proc/' + agent.identity.pid + '/stat', 'utf8');
      const fields = first.slice(first.lastIndexOf(')') + 2).trim().split(/\s+/);
      for (const pid of new Set([agent.identity.pid, Number(fields[3])])) {
        const source = '/proc/' + pid;
        if (statSync(source).uid !== process.getuid()) throw Error('Owned classifier PID uid mismatch');
        if (readlinkSync(source + '/cwd') !== agent.identity.cwd) throw Error('Owned classifier PID cwd mismatch');
        const pane = readFileSync(source + '/environ', 'utf8').split('\0').filter(s => s.startsWith('HARBOR_WB_PANEID='));
        if (pane.length !== 1 || pane[0] !== 'HARBOR_WB_PANEID=' + agent.paneid) throw Error('Owned classifier pane mismatch');
        const dest = join(root, String(pid));
        mkdirSync(join(dest, 'fd'), { recursive: true });
        for (const name of ['comm', 'cmdline']) writeFileSync(join(dest, name), readFileSync(source + '/' + name), { mode: 0o600 });
        writeFileSync(join(dest, 'environ'), pane[0] + '\0', { mode: 0o600 });
        // Live stat/uptime preserve actual start identity and foreground state;
        // no fabricated PID, tty, start time, or unrelated process environment.
        for (const [name, target] of [['stat', source + '/stat'], ['fd/0', readlinkSync(source + '/fd/0')], ['fd/1', readlinkSync(source + '/fd/1')]]) {
          const link = join(dest, name); rmSync(link, { force: true }); symlinkSync(target, link);
        }
      }
      const uptime = join(root, 'uptime');
      if (!existsSync(uptime)) symlinkSync('/proc/uptime', uptime);
    }
    const ready = async agent => {
      exposeOwnedProcess(agent);
      const { claudeOwner } = await tsImport('../src/engine/proc-classifier.ts', import.meta.url);
      const owner = claudeOwner(agent.paneid, { cached: false, root: join(dir, 'owned-proc') });
      if (!owner || typeof owner !== 'object' || owner.pid !== agent.identity.pid || owner.leader)
        throw Error('Inert foreground REPL must classify as the separate actual owned child');
      // A full inert turn is needed: Stop without a new UserPromptSubmit does
      // not advance the real typer's strict turn counter after a delivery.
      for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
        const r = await request('/api/claude-hook', { method: 'POST', value: { session_id: agent.identity.sessionId, hook_event_name } });
        if (r.status !== 200 || r.body?.matched !== agent.paneid) throw Error('Real vendor turn hook must match owned pane');
      }
      await sleep(150);
    };
    console.log('PROFILE T1 hosted=strict broker=owned-authenticated agents=inert traceText=test-only delivery=' + (delivery || 'hosted-default'));
    return { dir, base, binary, request, attach, send, writes, ready, close, events, brokerInputs, hasOriginTrace };
  } catch (error) {
    await close();
    // Never print the engine/broker ring: it may contain generated credentials.
    throw error;
  }
}
