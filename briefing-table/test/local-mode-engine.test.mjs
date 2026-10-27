/**
 * LOCAL MODE, the real engine (HARBOR_WB_MODE=local; src/engine/local-mode.ts): the desktop app's child process.
 *
 *   - refuses to start (exit 78, a configuration problem the supervisor must not retry) without a token, without a data dir, on a
 *     non-loopback host, or with accounts switched on;
 *   - prints exactly ONE bounded JSON ready line with the real port, and only then answers;
 *   - needs the token on every API request; /health stays open;
 *   - answers only the loopback Host on its own port (421 otherwise) and refuses a foreign WebSocket Origin;
 *   - never writes a token file;
 *   - on Linux, lists the native modules the process actually loaded (the answer to "which native modules does local mode need").
 *
 * SAFETY: a temp data dir; no broker (autostart off, a dead port); fabric and NATS off; the engine binds port 0. Run with node.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { childEnv, P, assertFree, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const DEAD_BROKER_PORT = P(552);
const TOKEN = 'local-test-token-0123456789';
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'wb-local-mode-'));
const appDir = join(tmp, 'app');
mkdirSync(join(appDir, 'modules', 'demo', 'ui'), { recursive: true });
writeFileSync(join(appDir, 'modules', 'demo', 'module.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1', class: 'tool', provides: ['demo.card'], contexts: ['workroom'], actions: 'actions.json', permissions: [] }));
writeFileSync(join(appDir, 'modules', 'demo', 'ui', 'page.js'), 'export {}');
const children = [];

function start(extra) {
  const dataDir = 'HARBOR_WB_DATA_DIR' in extra ? extra.HARBOR_WB_DATA_DIR : join(tmp, `data-${children.length}`);
  const proc = spawn(process.execPath, ['--import', LOADER, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_MODE: 'local',
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_DATA_DIR: dataDir,
      HARBOR_WB_FILES_DIR: join(tmp, 'files'),
      HARBOR_WB_MEMORY_CEILING_MB: '0', // the cap is off unless a test turns it on
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_APP_DIR: appDir,
      ...extra,
      HARBOR_WB_DATA_DIR: dataDir,
    }),
  });
  const rec = { proc, dataDir, out: '', err: '', exit: null, signal: null };
  proc.stdout.on('data', (d) => (rec.out += d));
  proc.stderr.on('data', (d) => (rec.err += d));
  proc.on('exit', (code, signal) => {
    rec.exit = code ?? -1; // killed by a signal has no code
    rec.signal = signal;
  });
  children.push(rec);
  return rec;
}

async function exited(rec, ms = 20000) {
  for (let t = 0; t < ms && rec.exit === null; t += 100) {
    await sleep(100);
  }
  return rec.exit;
}

function get(port, path, { host, token, method, headers } = {}) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: method ?? 'GET', headers: { host: host ?? `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

function upgrade(port, origin, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?paneid=x`, { headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 5000);
  });
}

try {
  await assertFree(DEAD_BROKER_PORT, 'local-mode-engine.test');

  /* ---- refusals: exit 78, naming what is wrong ---- */
  const noToken = start({ HARBOR_WB_TOKEN: '' });
  ok((await exited(noToken)) === 78 && /HARBOR_WB_TOKEN/.test(noToken.err), 'no token: exit 78 naming the token (never minted)');
  ok(!existsSync(join(noToken.dataDir, 'secrets', 'engine.token')), '...and no token file written');
  const noData = start({ HARBOR_WB_DATA_DIR: '' });
  ok((await exited(noData)) === 78 && /HARBOR_WB_DATA_DIR/.test(noData.err), 'no data dir: exit 78 naming it');
  const wideHost = start({ HARBOR_WB_HOST: '0.0.0.0' });
  ok((await exited(wideHost)) === 78 && /127\.0\.0\.1 only/.test(wideHost.err), 'a non-loopback host: exit 78');
  const accounts = start({ HARBOR_WB_IDENTITY: 'strict' });
  ok((await exited(accounts)) === 78 && /no accounts/.test(accounts.err), 'accounts switched on: exit 78');

  /* ---- a good start ---- */
  const eng = start({});
  let port = 0;
  for (let t = 0; t < 40000 && !port; t += 200) {
    await sleep(200);
    const first = eng.out.split('\n')[0];
    if (first.startsWith('{')) {
      try {
        port = JSON.parse(first).port;
      } catch {
        /* partial line */
      }
    }
    if (eng.exit !== null) {
      break;
    }
  }
  ok(port > 0, `the engine printed a ready line with a real port (${port})`);
  const outLines = eng.out.split('\n').filter((l) => l.trim() !== '');
  ok(outLines.length === 1 && outLines[0].length < 100 && JSON.parse(outLines[0]).ready === true, 'stdout holds exactly one line, the bounded ready line (logs go to stderr)');
  ok(eng.err.length > 0, 'the engine logs went to stderr');
  ok(!eng.out.includes(TOKEN) && !eng.err.includes(TOKEN), 'the token appears nowhere in the output');
  ok(port !== P(552) && port !== 7420 && port !== 8201, 'it did not take a live port');

  const health = await get(port, '/health');
  ok(health.status === 200, '/health answers without a token');
  const noTok = await get(port, '/api/table');
  ok(noTok.status === 401, 'an API route without the token: 401');
  const withTok = await get(port, '/api/table', { token: TOKEN });
  ok(withTok.status === 200, 'the same route with the token: 200');
  const wrongTok = await get(port, '/api/table', { token: 'not-the-token' });
  ok(wrongTok.status === 401, 'a wrong token: 401');
  const evil = await get(port, '/health', { host: `evil.example:${port}` });
  ok(evil.status === 421, 'a foreign Host name pointed at 127.0.0.1: 421');
  const wrongPort = await get(port, '/health', { host: `127.0.0.1:${port + 1}` });
  ok(wrongPort.status === 421, 'our address on another port: 421');
  const local = await get(port, '/health', { host: `localhost:${port}` });
  ok(local.status === 200, 'localhost on our port is fine');

  /* a sandboxed module frame sends Origin: null with no cookie: its page script is served; nothing else accepts that origin */
  const modNull = await get(port, '/app/modules/demo/ui/page.js', { headers: { origin: 'null' } });
  ok(modNull.status === 200 && modNull.headers['access-control-allow-origin'] === 'null', 'a module page GET with Origin: null and no token is served (ACAO null)');
  const modNoCors = await get(port, '/app/modules/demo/ui/page.js', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'style' } });
  ok(modNoCors.status === 200, 'a no-cors subresource (no Origin, Sec-Fetch-Site: cross-site) of a module page is served');
  ok((await get(port, '/api/modules', { headers: { 'sec-fetch-site': 'cross-site' }, token: TOKEN })).status === 403, 'but cross-site with no Origin on any other path is still refused');
  ok((await get(port, '/api/modules', { headers: { origin: 'null' }, token: TOKEN })).status === 403, 'but Origin: null on any other path is still refused');
  ok((await get(port, '/app/modules/demo/ui/page.js', { method: 'POST', headers: { origin: 'null' } })).status === 403, 'and a POST from a null origin never gets in, even on a module page path');
  /* a web page in the user's own browser can reach the port: it must not reach the token-free routes or the sockets */
  const hookOk = await get(port, '/api/claude-hook', { method: 'POST' });
  ok(hookOk.status === 200, 'the hook sink still takes a plain local POST (the hook\'s curl sends no Origin)');
  const hookEvil = await get(port, '/api/claude-hook', { method: 'POST', headers: { origin: 'http://evil.example' } });
  ok(hookEvil.status === 403, 'the same POST from a foreign Origin is refused (a web page cannot paint the rings)');
  const hookAgentEvil = await get(port, '/api/agent-hook', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
  ok(hookAgentEvil.status === 403, '/api/agent-hook with Sec-Fetch-Site cross-site is refused too');
  const loginEvil = await get(port, '/login', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' } });
  ok(loginEvil.status === 403, '/login from a foreign Origin is refused (so a web page cannot burn the login throttle)');
  const termEvil = await new Promise((resolve) => {
    const r = request({ host: '127.0.0.1', port, path: '/term', headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    r.on('response', (res) => resolve(res.statusCode));
    r.on('upgrade', (res) => resolve(res.statusCode));
    r.on('error', () => resolve(0));
    r.end();
    setTimeout(() => resolve('timeout'), 4000);
  });
  ok(termEvil === 403 || termEvil === 0, `/term from a foreign Origin never upgrades (${termEvil})`);
  /* the app's own origin, app://workbench, is allowed on the two paths that use it (terminal grants and /term) and nowhere else */
  const appHealth = await get(port, '/health', { headers: { origin: 'app://workbench' } });
  ok(appHealth.status === 403 && /origin-not-allowed/.test(appHealth.body), 'app://workbench is NOT allowed on ordinary routes (the main process sends no Origin there)');
  const appGrant = await get(port, '/api/terminal-grants', { method: 'POST', headers: { origin: 'app://workbench' } });
  ok(!/origin-not-allowed/.test(appGrant.body), `app://workbench passes the origin gate on /api/terminal-grants (answers ${appGrant.status})`);
  const appTerm = await upgrade(port, 'app://workbench', undefined);
  ok(appTerm === 403, '/pty from app://workbench is refused too (the app\'s main process sends no Origin on /pty)');
  ok((await upgrade(port, 'http://evil.example', TOKEN)) === 403, 'a WebSocket from a foreign Origin is refused (403) even with the token');
  ok((await upgrade(port, undefined, undefined)) === 401, 'a WebSocket without the token: 401');
  const passed_gate = await upgrade(port, undefined, TOKEN);
  ok(passed_gate !== 401 && passed_gate !== 403, `a WebSocket with the token and no Origin passes the gate (${passed_gate})`);

  ok(!existsSync(join(eng.dataDir, 'secrets', 'engine.token')), 'no token file was written under the data dir');
  ok(!existsSync(join(REPO_ROOT, 'secrets', 'engine.token')) || readFileSync(join(REPO_ROOT, 'secrets', 'engine.token'), 'utf8').trim() !== TOKEN, 'and none under the install folder');
  ok(existsSync(eng.dataDir) && readdirSync(eng.dataDir).length > 0, 'its data went to the data dir');

  /* ---- which native modules did it load? (Linux: /proc maps) ---- */
  if (process.platform === 'linux') {
    const maps = readFileSync(`/proc/${eng.proc.pid}/maps`, 'utf8');
    const loaded = [...new Set([...maps.matchAll(/(\/[^\s]*node_modules\/[^\s]*\.node)/g)].map((m) => m[1].replace(/^.*node_modules\//, '')))];
    console.log(`  native modules loaded by the local-mode engine: ${loaded.join(', ') || '(none)'}`);
    ok(loaded.some((f) => f.includes('better-sqlite3')), 'better-sqlite3 is loaded (the table)');
    ok(!loaded.some((f) => /argon2|sharp|resvg/.test(f)), 'argon2, sharp and resvg are NOT loaded at boot');
  }

  /* ---- assets in the person's own folder (no agent-share) ---- */
  const assetDir = join(tmp, 'assets-data');
  mkdirSync(join(assetDir, 'data'), { recursive: true });
  const seededA = await new Promise((resolve) => {
    const sd = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ rooms: [{ name: 'Pics', seats: [] }, { name: `A very long room name ${'x'.repeat(90)}`, seats: [] }] })], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_TABLE: join(assetDir, 'data', 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }),
    });
    let o = '';
    sd.stdout.on('data', (d) => (o += d));
    sd.on('exit', () => resolve(o));
  });
  const roomA = JSON.parse(String(seededA).trim().split('\n').pop()).rooms[0];
  const filesDir = join(tmp, 'my-files');
  const assetEng = start({ HARBOR_WB_DATA_DIR: assetDir, HARBOR_WB_FILES_DIR: filesDir });
  let aPort = 0;
  for (let t = 0; t < 40000 && !aPort && assetEng.exit === null; t += 200) {
    await sleep(200);
    try {
      aPort = JSON.parse(assetEng.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  ok(aPort > 0, 'an engine with a files folder and a seeded room is up');
  const fileStore = await get(aPort, '/api/rooms/file-store', { token: TOKEN });
  ok(fileStore.status === 200 && JSON.parse(fileStore.body).configured === true && JSON.parse(fileStore.body).source === 'folder', 'the file store reports itself as a folder store, configured');
  const winCookie = await windowCookie(`http://127.0.0.1:${aPort}`, TOKEN); // a person's window, not a bearer
  const uploaded = await new Promise((resolve) => {
    const body = Buffer.from('hello from the local folder');
    const r = request({ host: '127.0.0.1', port: aPort, path: `/api/rooms/${roomA.id}/assets`, method: 'POST', headers: { host: `127.0.0.1:${aPort}`, cookie: winCookie, 'x-filename': 'note.txt', 'content-type': 'text/plain', 'content-length': String(body.length) } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    r.end(body);
  });
  ok(uploaded.status === 200 || uploaded.status === 201, `an asset upload is accepted without any agent-share (${uploaded.status} ${uploaded.body.slice(0, 120)})`);
  const onDisk = join(filesDir, 'rooms', `${(roomA.name || '').toLowerCase()}-${roomA.id.replace(/-/g, '').slice(0, 8)}`, 'assets', 'note.txt');
  const longRoom = JSON.parse(String(seededA).trim().split('\n').pop()).rooms[1];
  const longUp = await new Promise((resolve) => {
    const body = Buffer.from('x');
    const r = request({ host: '127.0.0.1', port: aPort, path: `/api/rooms/${longRoom.id}/assets`, method: 'POST', headers: { host: `127.0.0.1:${aPort}`, cookie: winCookie, 'x-filename': 'a.txt', 'content-type': 'text/plain', 'content-length': '1' } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    r.end(body);
  });
  const longPath = JSON.parse(longUp.body || '{}').path ?? '';
  ok(longUp.status === 200 && longPath.split('/')[1].length <= 40 + 9, `a very long room name gives a capped folder (${longPath.split('/')[1]?.length} characters)`);
  const upBin = (name, bytes) =>
    new Promise((resolve) => {
      const r = request({ host: '127.0.0.1', port: aPort, path: `/api/rooms/${roomA.id}/assets`, method: 'POST', headers: { host: `127.0.0.1:${aPort}`, cookie: winCookie, 'x-filename': name, 'content-type': 'image/png', 'content-length': String(bytes.length) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve(0));
      r.end(bytes);
    });
  ok((await upBin('bad.png', Buffer.from('this is not a png at all'))) === 200, 'a file named .png that is not an image is accepted as an asset');
  const badThumb = await get(aPort, `/api/rooms/${roomA.id}/assets/thumb/bad.png`, { token: TOKEN });
  ok(badThumb.status === 415, `ONE unreadable image: the thumbnail answers 415 for that file (${badThumb.status})`);
  ok(existsSync(onDisk) && readFileSync(onDisk, 'utf8') === 'hello from the local folder', 'the file is in the person\'s folder: rooms/<room>/assets/note.txt');
  const listedA = await get(aPort, `/api/rooms/${roomA.id}/assets`, { token: TOKEN });
  ok(listedA.status === 200 && listedA.body.includes('note.txt'), 'the room\'s asset list shows it');
  const rawA = await get(aPort, `/api/rooms/${roomA.id}/assets/raw/note.txt`, { token: TOKEN });
  ok(rawA.status === 200 && rawA.body === 'hello from the local folder', 'the raw route serves it back');
  assetEng.proc.kill('SIGTERM');
  await exited(assetEng);
  /* no encoder at all (sharp is not shipped in the local release): its own answer, so a client can stop asking */
  const noEnc = start({ HARBOR_WB_DATA_DIR: assetDir, HARBOR_WB_FILES_DIR: filesDir, HARBOR_WB_NO_IMAGE_ENCODER: '1' });
  let ePort = 0;
  for (let t = 0; t < 40000 && !ePort && noEnc.exit === null; t += 200) {
    await sleep(200);
    try {
      ePort = JSON.parse(noEnc.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  const noEncThumb = await get(ePort, `/api/rooms/${roomA.id}/assets/thumb/bad.png`, { token: TOKEN });
  ok(noEncThumb.status === 501 && /no thumbnails/.test(noEncThumb.body), `with no image encoder the thumbnail answers 501, a different answer from one bad file (${noEncThumb.status})`);
  const noEncRaw = await get(ePort, `/api/rooms/${roomA.id}/assets/raw/bad.png`, { token: TOKEN });
  ok(noEncRaw.status === 200, '...and the full image is still served');
  noEnc.proc.kill('SIGTERM');
  await exited(noEnc);

  /* ---- notes: the database row is the truth, and a read-only .md copy lands in the person's folder ---- */
  const noteData = join(tmp, 'notes-data');
  mkdirSync(join(noteData, 'data'), { recursive: true });
  const seededN = await new Promise((resolve) => {
    const sd = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ rooms: [{ name: 'Jots', seats: [] }] })], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_TABLE: join(noteData, 'data', 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }),
    });
    let o = '';
    sd.stdout.on('data', (d) => (o += d));
    sd.on('exit', () => resolve(o));
  });
  const roomN = JSON.parse(String(seededN).trim().split('\n').pop()).rooms[0];
  const notesFiles = join(tmp, 'note-files');
  const noteEng = start({ HARBOR_WB_DATA_DIR: noteData, HARBOR_WB_FILES_DIR: notesFiles, HARBOR_WB_NOTE_COPY_MS: '700' });
  let nPort = 0;
  for (let t = 0; t < 40000 && !nPort && noteEng.exit === null; t += 200) {
    await sleep(200);
    try {
      nPort = JSON.parse(noteEng.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  const nCookie = await windowCookie(`http://127.0.0.1:${nPort}`, TOKEN);
  const json = (method, path, body) =>
    new Promise((resolve) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const r = request({ host: '127.0.0.1', port: nPort, path, method, headers: { host: `127.0.0.1:${nPort}`, cookie: nCookie, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
      });
      r.on('error', (e) => resolve({ status: 0, json: null, err: String(e) }));
      r.end(data ?? undefined);
    });
  const made = await json('POST', `/api/rooms/${roomN.id}/notes`, { text: '# Trip plan\nfirst draft' });
  const noteId = made.json?.id ?? made.json?.note?.id;
  ok(made.status === 200 && typeof noteId === 'string', `a note is created (${made.status})`);
  for (let i = 0; i < 30; i++) {
    await json('PUT', `/api/rooms/${roomN.id}/notes/${noteId}`, { text: `# Trip plan\nedit number ${i}` });
  }
  const notesDirOnDisk = join(notesFiles, 'rooms', `${roomN.name.toLowerCase()}-${roomN.id.replace(/-/g, '').slice(0, 8)}`, 'notes');
  ok(!existsSync(notesDirOnDisk) || readdirSync(notesDirOnDisk).length === 0, 'right after a burst of 31 saves nothing is written yet (rationed, not per keystroke)');
  await sleep(2200);
  const copies = existsSync(notesDirOnDisk) ? readdirSync(notesDirOnDisk).filter((n) => n.endsWith('.md')) : [];
  ok(copies.length === 1 && copies[0] === `trip-plan-${noteId}.md`, `the burst produced exactly ONE copy (${copies.join(', ') || 'none'})`);
  const copyText = copies[0] ? readFileSync(join(notesDirOnDisk, copies[0]), 'utf8') : '';
  ok(copyText.split('\n')[0].startsWith('> Read-only copy.') && copyText.includes('edit number 29') && !copyText.includes('edit number 28'), 'it starts with the read-only line and carries the LATEST text');
  ok(copies[0] && (statSync(join(notesDirOnDisk, copies[0])).mode & 0o222) === 0, 'it carries the read-only attribute');
  chmodSync(join(notesDirOnDisk, copies[0]), 0o666);
  writeFileSync(join(notesDirOnDisk, copies[0]), 'THE USER EDITED THE COPY');
  const reread = await json('GET', `/api/rooms/${roomN.id}/notes/${noteId}`);
  ok(reread.status === 200 && String(reread.json?.text).includes('edit number 29') && !String(reread.json?.text).includes('THE USER EDITED'), 'editing the copy does not change the note');
  await json('PUT', `/api/rooms/${roomN.id}/notes/${noteId}`, { text: '# Trip plan\nthe last save before quitting' });
  noteEng.proc.kill('SIGTERM'); // inside the 700 ms window: the pending copy must be written on the way out
  await exited(noteEng);
  ok(readFileSync(join(notesDirOnDisk, copies[0]), 'utf8').includes('the last save before quitting'), 'a pending copy is written when the engine stops');

  /* ---- the chat-history export: finished days land in the person's folder ---- */
  process.env.TZ = 'America/Los_Angeles'; // the PC's zone for this test; the engine gets the same
  const histData = join(tmp, 'hist-data');
  mkdirSync(join(histData, 'data'), { recursive: true });
  const seededH = await new Promise((resolve) => {
    const sd = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ rooms: [{ name: 'Hist', seats: [] }] })], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_TABLE: join(histData, 'data', 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }),
    });
    let o = '';
    sd.stdout.on('data', (d) => (o += d));
    sd.on('exit', () => resolve(o));
  });
  const roomH = JSON.parse(String(seededH).trim().split('\n').pop()).rooms[0];
  const dayAgo = (n, h = 10) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  const ymd = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  {
    const db0 = new Database(join(histData, 'data', 'mapping.db'));
    const ins = db0.prepare('INSERT INTO room_line (room_id, ts, kind, author, body, meta) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(roomH.id, dayAgo(3), 'chat', 'user', 'three days ago', null);
    ins.run(roomH.id, dayAgo(3, 11), 'delivery', 'room', 'not delivered - receipts are not history', null);
    ins.run(roomH.id, dayAgo(2), 'chat', 'user', 'two days ago', '{"to_user":true}');
    ins.run(roomH.id, dayAgo(2, 12), 'fact', 'room', 'hidden bookkeeping', '{"hidden":true}');
    ins.run(roomH.id, Date.now(), 'chat', 'user', 'today is not exported automatically', null);
    db0.close();
  }
  const histFiles = join(tmp, 'hist-files');
  const histEng = start({ TZ: 'America/Los_Angeles', HARBOR_WB_DATA_DIR: histData, HARBOR_WB_FILES_DIR: histFiles, HARBOR_WB_HISTORY_EXPORT_DELAY_MS: '300' });
  let hPort = 0;
  for (let t = 0; t < 40000 && !hPort && histEng.exit === null; t += 200) {
    await sleep(200);
    try {
      hPort = JSON.parse(histEng.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  const histDir = join(histFiles, 'rooms', `hist-${roomH.id.replace(/-/g, '').slice(0, 8)}`, 'history');
  for (let t = 0; t < 8000 && !(existsSync(histDir) && readdirSync(histDir).length >= 2); t += 200) {
    await sleep(200);
  }
  const histNames = existsSync(histDir) ? readdirSync(histDir).filter((n) => n.endsWith('.jsonl')).sort() : [];
  ok(histNames.join() === `${ymd(dayAgo(3))}.jsonl,${ymd(dayAgo(2))}.jsonl`, `the catch-up wrote one file per finished day with lines, and not today (${histNames.join(', ') || 'none'})`);
  const day3 = histNames[0] ? readFileSync(join(histDir, histNames[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  ok(day3[0]?.schema === 1 && day3[0]?.room?.id === roomH.id && /^[+-]\d\d:\d\d$/.test(day3[0]?.utcOffset ?? '') && day3[0]?.lines === 1, 'each file starts with a header (schema, room, day, UTC offset, line count)');
  ok(day3.length === 2 && day3[1].body === 'three days ago', 'delivery receipts are left out, the chat line is in');
  const day2 = histNames[1] ? readFileSync(join(histDir, histNames[1]), 'utf8') : '';
  ok(day2.includes('two days ago') && !day2.includes('hidden bookkeeping'), 'hidden bookkeeping lines are left out');
  ok(!readdirSync(histDir).some((n) => n.includes('today')) && ![...histNames].some((n) => readFileSync(join(histDir, n), 'utf8').includes('today is not exported')), 'today\'s line is in no file');
  const hst = JSON.parse((await get(hPort, '/api/history-export', { token: TOKEN })).body);
  ok(hst.enabled === true && hst.running === false && hst.written === 2 && typeof hst.folder === 'string', `the status endpoint reports it (written ${hst.written})`);
  const nowRes = JSON.parse((await get(hPort, '/api/history-export/run', { token: TOKEN, method: 'POST', headers: { 'content-type': 'application/json' } })).body || '{}');
  ok(nowRes.started === false || nowRes.started === true, 'a plain run request is accepted in the background');
  // Export now needs a JSON body; send it with a tiny helper
  const exportNow = await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ now: true }));
    const r = request({ host: '127.0.0.1', port: hPort, path: '/api/history-export/run', method: 'POST', headers: { host: `127.0.0.1:${hPort}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(data.length) } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    r.on('error', () => resolve({ status: 0, json: {} }));
    r.end(data);
  });
  const nowFile = exportNow.json.files?.[0];
  ok(exportNow.status === 200 && nowFile && /-now-\d{6}\.jsonl$/.test(nowFile.name) && existsSync(join(histDir, nowFile.name)), `Export now saves today so far under its own name (${nowFile?.name})`);
  ok(readFileSync(join(histDir, nowFile?.name ?? 'x'), 'utf8').includes('today is not exported automatically') && JSON.parse(readFileSync(join(histDir, nowFile.name), 'utf8').split('\n')[0]).partial === true, '...it holds today\'s line and says it is partial');
  const before = readdirSync(histDir).length;
  await get(hPort, '/api/history-export/run', { token: TOKEN, method: 'POST', headers: { 'content-type': 'application/json' } });
  await sleep(800);
  ok(readdirSync(histDir).length === before, 'running the catch-up again writes nothing new (the marker holds)');
  const cancelRes = await get(hPort, '/api/history-export/cancel', { token: TOKEN, method: 'POST', headers: { 'content-type': 'application/json' } });
  ok(cancelRes.status === 200 && JSON.parse(cancelRes.body).running === false, 'cancel over HTTP answers the status (nothing was running)');
  const off = await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ enabled: false }));
    const r = request({ host: '127.0.0.1', port: hPort, path: '/api/history-export', method: 'PATCH', headers: { host: `127.0.0.1:${hPort}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(data.length) } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    r.on('error', () => resolve({ status: 0, json: {} }));
    r.end(data);
  });
  ok(off.status === 200 && off.json.enabled === false, 'the toggle switches it off');
  const refused = await get(hPort, '/api/history-export/run', { token: TOKEN, method: 'POST', headers: { 'content-type': 'application/json' } });
  ok(refused.status === 409, 'with the toggle off a catch-up request is refused (409)');
  /* ---- the graceful stop the app uses where there is no SIGTERM (Windows) ---- */
  const shutNoTok = await get(hPort, '/api/local/shutdown', { method: 'POST' });
  ok(shutNoTok.status === 401, 'shutdown without the token: 401 (the engine keeps running)');
  const evilOrigin = await get(hPort, '/api/local/shutdown', { method: 'POST', token: TOKEN, headers: { origin: 'http://evil.example' } });
  ok(evilOrigin.status === 403, 'shutdown from a foreign Origin: 403');
  const appOrigin = await get(hPort, '/api/local/shutdown', { method: 'POST', token: TOKEN, headers: { origin: 'app://workbench' } });
  ok(appOrigin.status === 403, 'shutdown with any Origin at all is refused (only the supervisor\'s own call, which sends none)');
  ok((await get(hPort, '/health')).status === 200, '...and the engine is still up after those three');
  const stopAt = Date.now();
  const stop = await get(hPort, '/api/local/shutdown', { method: 'POST', token: TOKEN });
  ok(stop.status === 200 && JSON.parse(stop.body).stopping === true, 'shutdown with the token: 200');
  ok((await exited(histEng, 4000)) === 0 && Date.now() - stopAt < 2000, `the engine exits 0 within 2 seconds (${Date.now() - stopAt} ms)`);
  ok(!existsSync(join(histData, 'engine.lock')), '...and releases its lock');

  /* ---- the first-run seed recipe: a room works with no setup; a deleted seed stays deleted ---- */
  const seedData = join(tmp, 'seed-data');
  const seedFiles = join(tmp, 'seed-files');
  const bootSeed = async () => {
    const rec = start({ HARBOR_WB_DATA_DIR: seedData, HARBOR_WB_FILES_DIR: seedFiles });
    let p = 0;
    for (let t = 0; t < 40000 && !p && rec.exit === null; t += 200) {
      await sleep(200);
      try {
        p = JSON.parse(rec.out.split('\n')[0]).port;
      } catch {
        /* not yet */
      }
    }
    return { rec, port: p };
  };
  const recipesOf = async (p) => JSON.parse((await get(p, '/api/recipes', { token: TOKEN })).body).recipes;
  const expectName = process.platform === 'win32' ? 'PowerShell' : 'Shell';
  let s1 = await bootSeed();
  let seedList = await recipesOf(s1.port);
  ok(seedList.length === 1 && seedList[0].id === 'seed-shell' && seedList[0].name === expectName && seedList[0].target === 'local' && seedList[0].vendor === 'cli-manager', `the first start seeds ONE recipe: "${seedList[0]?.name}" on This machine (target local), a plain shell`);
  ok(/first-run recipe: seeded/.test(s1.rec.err), '...and says so in the log');
  /* a room with no seats is fine, and a seat on the seed recipe can be added later */
  const seedCookie = await windowCookie(`http://127.0.0.1:${s1.port}`, TOKEN);
  const jsonCall = (port, method, path, body, cookie) =>
    new Promise((resolve) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const r = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, cookie, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
      });
      r.on('error', () => resolve({ status: 0, json: null }));
      r.end(data ?? undefined);
    });
  const noSeatRoom = await jsonCall(s1.port, 'POST', '/api/rooms', { name: 'No seats yet' }, seedCookie);
  ok(noSeatRoom.status === 200 && noSeatRoom.json?.id, 'a room is created with NO seats');
  const listedRooms = await jsonCall(s1.port, 'GET', '/api/rooms', undefined, seedCookie);
  ok(JSON.stringify(listedRooms.json).includes('No seats yet'), '...and it is listed');
  const lateSeat = await jsonCall(s1.port, 'POST', `/api/rooms/${noSeatRoom.json.id}/seats`, { recipe_id: 'seed-shell', handle: 'shell', policy: 'persistent' }, seedCookie);
  ok(lateSeat.status === 200, `...and a seat on the seed recipe is added later (${lateSeat.status})`);
  s1.rec.proc.kill('SIGTERM');
  await exited(s1.rec);
  s1 = await bootSeed();
  seedList = await recipesOf(s1.port);
  ok(seedList.length === 1 && /first-run recipe: marker/.test(s1.rec.err), 'a restart seeds nothing more (still one recipe; the marker holds)');
  const seatedDelete = await jsonCall(s1.port, 'DELETE', '/api/recipes/seed-shell', undefined, seedCookie);
  ok(seatedDelete.status === 409, 'a seed recipe a seat fills cannot be deleted from under it (409), the existing rule');
  s1.rec.proc.kill('SIGTERM');
  await exited(s1.rec);
  /* a person who deletes the seed keeps it deleted: use a fresh folder where nothing sits on the recipe */
  const seedData2 = join(tmp, 'seed-data-2');
  const boot2 = async () => {
    const rec = start({ HARBOR_WB_DATA_DIR: seedData2, HARBOR_WB_FILES_DIR: join(tmp, 'seed-files-2') });
    let p = 0;
    for (let t = 0; t < 40000 && !p && rec.exit === null; t += 200) {
      await sleep(200);
      try {
        p = JSON.parse(rec.out.split('\n')[0]).port;
      } catch {
        /* not yet */
      }
    }
    return { rec, port: p };
  };
  let b2 = await boot2();
  const cookie2 = await windowCookie(`http://127.0.0.1:${b2.port}`, TOKEN);
  const del = await jsonCall(b2.port, 'DELETE', '/api/recipes/seed-shell', undefined, cookie2);
  ok(del.status === 200 && (await recipesOf(b2.port)).length === 0, 'the person deletes the seed');
  b2.rec.proc.kill('SIGTERM');
  await exited(b2.rec);
  b2 = await boot2();
  ok((await recipesOf(b2.port)).length === 0 && /first-run recipe: marker/.test(b2.rec.err), 'after a restart the deleted seed is NOT recreated');
  b2.rec.proc.kill('SIGTERM');
  await exited(b2.rec);

  /* ---- the supervisor can allow the app's own origin ---- */
  const withOrigin = start({ HARBOR_WB_ALLOWED_ORIGINS: 'app://workbench' });
  let oPort = 0;
  for (let t = 0; t < 40000 && !oPort && withOrigin.exit === null; t += 200) {
    await sleep(200);
    try {
      oPort = JSON.parse(withOrigin.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  ok((await get(oPort, '/health', { headers: { origin: 'app://workbench' } })).status === 200, 'an origin the supervisor allowed passes');
  ok((await get(oPort, '/health', { headers: { origin: 'app://other' } })).status === 403, '...and another one does not');
  withOrigin.proc.kill('SIGTERM');
  await exited(withOrigin);

  /* ---- the data folder: ours alone ---- */
  const second = start({ HARBOR_WB_DATA_DIR: eng.dataDir });
  ok((await exited(second)) === 78 && /already using the data folder/.test(second.err), 'a second engine on the same data folder: exit 78, naming the first');
  ok(existsSync(join(eng.dataDir, 'engine.lock')), 'the running engine holds the lock');

  eng.proc.kill('SIGTERM');
  ok((await exited(eng)) === 0, 'SIGTERM is a clean stop (exit 0)');
  ok(!existsSync(join(eng.dataDir, 'engine.lock')), '...and releases the lock');

  /* a crashed engine leaves a lock behind: the next start takes it over */
  const staleDir = join(tmp, 'stale');
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, 'engine.lock'), JSON.stringify({ pid: 2147483000, startedAt: 1 }));
  const afterCrash = start({ HARBOR_WB_DATA_DIR: staleDir });
  let stalePort = 0;
  for (let t = 0; t < 40000 && !stalePort && afterCrash.exit === null; t += 200) {
    await sleep(200);
    try {
      stalePort = JSON.parse(afterCrash.out.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  ok(stalePort > 0, 'a stale lock (its process is gone) does not block the next start');
  afterCrash.proc.kill('SIGTERM');
  await exited(afterCrash);

  /* ---- the memory cap: over the ceiling, one line in every open room, exit 75 ---- */
  const capDir = join(tmp, 'cap');
  mkdirSync(join(capDir, 'data'), { recursive: true });
  const seeded = await new Promise((resolve) => {
    const seed = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ rooms: [{ name: 'Capped', seats: [] }] })], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_TABLE: join(capDir, 'data', 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }),
    });
    let out = '';
    seed.stdout.on('data', (d) => (out += d));
    seed.on('exit', () => resolve(out));
  });
  ok(String(seeded).includes('Capped'), 'a room was seeded in the data folder for the cap test');
  const capped = start({ HARBOR_WB_DATA_DIR: capDir, HARBOR_WB_MEMORY_CEILING_MB: '1', HARBOR_WB_MEMORY_CHECK_MS: '200' });
  ok((await exited(capped, 40000)) === 75, 'over the ceiling the engine exits 75');
  ok(/MEMORY CAP/.test(capped.err), '...and logs why');
  ok(!existsSync(join(capDir, 'engine.lock')), '...and releases its lock');
  const db = new Database(join(capDir, 'data', 'mapping.db'), { readonly: true });
  const facts = db.prepare("SELECT body FROM room_line WHERE kind = 'fact'").all().map((r) => r.body);
  db.close();
  ok(facts.some((b) => /restarting to free memory/.test(b)), `the open room got one line saying so ("${facts.find((b) => /restarting/.test(b)) ?? 'none'}")`);
  ok(facts.filter((b) => /restarting to free memory/.test(b)).length === 1, 'exactly one such line');
} catch (e) {
  failed++;
  console.log(`  FAIL harness: ${e?.stack ?? e}`);
} finally {
  for (const c of children) {
    if (c.exit === null) {
      c.proc.kill('SIGKILL');
    }
  }
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
