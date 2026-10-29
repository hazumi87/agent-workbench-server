#!/usr/bin/env node
/*
 * The checks and verbs behind the scripts, in one place so every script reads
 * app state the same way. Zero dependencies (node >= 20).
 *
 *   status [--publish]           -> the pulse: one JSON line {state, pid, port, lastExit, configured, checkedAt, reason}.
 *                                   Read-only. --publish (start.sh / stop.sh, under their lock) also writes status/widget.json
 *   preflight [--json]           -> readiness; publishes status/widget.json; exit 0 ready / 1 something down / 2 could not tell
 *   instances                    -> every live pid running this app, one per line; exit 2 when /proc cannot be read
 *   clear-stale                  -> no instance running but run files remain: record a fault exit, remove them, say so
 *   wait-ready <pid> <ms>
 *   call <verb> <room> [id]      -> call one of the app's verbs (JSON body on stdin for writes); prints the JSON answer
 *   look <asset-id>              -> download a Library image to work/look/ and print its path (so the resident can SEE it)
 *   register-panel <room>        -> (re)registers this room's Asset Studio panel on this pane's seat
 *   bind <room>                  -> bind the app to ONE room (config.mjs BINDING, 0600): this pane's seat there + the room's name
 *   post [room]                  -> posts stdin as one room line, authored by this pane (HARBOR_WB_PANEID)
 *   rooms                        -> the open rooms where this pane holds a seat: [{id, name, seat, handle}]
 *
 * THREE OUTCOMES, NEVER TWO: up / down / unknown. `state` answers "is it
 * running" only: `down` = certainly not running, `unknown` = could not tell.
 * HOW the last run ended is a separate field, `lastExit: clean | fault | null`.
 * "Running" means /health answers — even {ok:false, reason:'not-configured'}:
 * an app whose engine is offline is up; the engine is preflight's second step.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instancesOf, readJson, recordExit, writeWidget } from '../../app/state.mjs';
import { BINDING, readBinding, readConfig } from '../../app/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATUS_DIR = path.join(ROOT, 'status');
const PID_FILE = path.join(STATUS_DIR, 'app.pid');
const APP_JSON = path.join(STATUS_DIR, 'app.json');
const EXIT_JSON = path.join(STATUS_DIR, 'exit.json');
const WIDGET = path.join(STATUS_DIR, 'widget.json');
const APP_MAIN = path.join(ROOT, 'app', 'server.mjs');

function readPid() {
  try {
    const n = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/* Never throws: a URL that will not parse is an answer ({error}), not a crash. */
function request(url, { method = 'GET', body = null, headers = {}, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const data = body === null ? null : JSON.stringify(body);
    let req;
    try {
      req = (url.startsWith('https:') ? https : http).request(
        url,
        {
          method,
          timeout: timeoutMs,
          headers: { ...headers, ...(data && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* not JSON */
            }
            resolve({ status: res.statusCode, json, text });
          });
        },
      );
    } catch (e) {
      resolve({ error: e.code || e.message });
      return;
    }
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

/* /health answered by THIS app (either ok value). */
const answering = (r) => r.status === 200 && typeof r.json?.ok === 'boolean';

/** The app's state, from the outside. Read-only. */
export async function appState() {
  const checkedAt = new Date().toISOString();
  const info = readJson(APP_JSON);
  const pidFile = readPid();
  const last = readJson(EXIT_JSON);
  const lastExit = last?.kind === 'clean' || last?.kind === 'fault' ? last.kind : null;
  const out = (state, pid, reason, extra = {}) => ({ state, pid, port: null, lastExit, checkedAt, reason, ...extra });

  const found = instancesOf(APP_MAIN);
  if (found === null) {
    return out('unknown', pidFile, 'cannot read the process table (/proc)');
  }
  if (found.length === 0) {
    const stale = pidFile ?? (Number.isInteger(info?.pid) ? info.pid : null);
    if (stale === null) {
      return out('down', null, 'not running', { pid: lastExit === 'fault' ? (last.pid ?? null) : null });
    }
    const whose = alive(stale) ? `pid ${stale} now belongs to another process` : `pid ${stale} is gone`;
    return out('down', stale, `not running; ${whose} and its run files remain, so it did not exit cleanly (crash, kill, reboot)`, {
      lastExit: 'fault',
    });
  }
  if (found.length > 1) {
    return out('unknown', null, `${found.length} instances are running (pids ${found.join(', ')}) — stop.sh stops them all`);
  }
  const [pid] = found;
  if (pidFile !== pid) {
    return out('unknown', pid, `pid ${pid} is this app but no pid file names it (started outside start.sh?) — stop.sh stops it`);
  }
  const port = info?.pid === pid && Number.isInteger(info.port) ? info.port : null;
  if (port === null) {
    return out('unknown', pid, `pid ${pid} is running but has not published its port yet (starting?)`);
  }
  const r = await request(`http://127.0.0.1:${port}/health`, { timeoutMs: 1500 });
  if (answering(r)) {
    return out('up', pid, `answering on 127.0.0.1:${port}`, { port, configured: !!r.json.engine?.ok, bound: r.json.bound?.room_id ?? null });
  }
  return out('unknown', pid, `pid ${pid} is running but /health ${r.error ? `failed: ${r.error}` : `answered HTTP ${r.status}`}`, { port });
}

/* The status line follows what was just observed. A failed write is reported,
   never fatal: the answer on stdout matters more than the chip. */
function publish(s) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    writeWidget(WIDGET, s);
  } catch (e) {
    console.error(`could not write ${WIDGET}: ${e.code || e.message}`);
  }
}

function clearStale() {
  const found = instancesOf(APP_MAIN);
  const files = [PID_FILE, APP_JSON].filter((f) => fs.existsSync(f));
  if (found === null || found.length || !files.length) {
    return 0;
  }
  const pid = readPid() ?? readJson(APP_JSON)?.pid ?? null;
  recordExit(EXIT_JSON, 'fault', pid, 'run files left behind: the app did not exit cleanly');
  for (const f of files) {
    fs.rmSync(f, { force: true });
  }
  console.log(`cleared stale run files for pid ${pid ?? '?'} (it did not exit cleanly)`);
  return 0;
}

/* image-gen + the GPU engine behind it, checked from here (not through the app) so it
   answers whether the app is up or not. Offline is the USER's call to fix (the GPU host
   engine is started by a human, never by this tool). */
async function engineState() {
  const base = readConfig().imageGenUrl;
  const h = await request(`${base}/health`, { timeoutMs: 5000 });
  if (h.error === 'ECONNREFUSED') {
    return { name: 'image-gen', state: 'down', detail: `nothing listening at ${base}` };
  }
  if (h.error || h.status !== 200) {
    return { name: 'image-gen', state: h.error ? 'unknown' : 'down', detail: `${base}/health ${h.error ? `failed: ${h.error}` : `answered HTTP ${h.status}`}` };
  }
  return h.json?.engine?.ok
    ? { name: 'image-gen', state: 'up', detail: `engine ${h.json.engine.state ?? 'ok'}` }
    : { name: 'image-gen', state: 'down', detail: 'engine offline — ask the user to start it on the GPU host; never start it yourself' };
}

function bindingState() {
  const b = readBinding();
  return b
    ? { name: 'room', state: 'up', detail: `bound to "${b.room_name ?? b.room_id}" as @${b.agent ?? '?'}` }
    : { name: 'room', state: 'down', detail: 'not bound — scripts/bind.sh <room>' };
}

async function preflight(asJson) {
  const app = await appState();
  publish(app);
  const steps = [{ name: 'app', state: app.state, detail: app.state === 'up' ? `port ${app.port} (pid ${app.pid})` : app.reason }, await engineState(), bindingState()];
  const down = steps.filter((s) => s.state === 'down').map((s) => s.name);
  const unknown = steps.filter((s) => s.state === 'unknown').map((s) => s.name);
  const ready = !down.length && !unknown.length;
  const report = { ready, steps, down, unknown, lastExit: app.lastExit, checkedAt: new Date().toISOString() };
  if (asJson) {
    console.log(JSON.stringify(report));
  } else {
    console.log('preflight asset-studio');
    for (const s of steps) {
      console.log(`  ${s.name.padEnd(12)} ${s.state.toUpperCase().padEnd(8)} ${s.detail}`);
    }
    console.log(
      ready
        ? '=> READY'
        : `=> NOT READY${down.length ? ` — down: ${down.join(', ')}` : ''}${unknown.length ? ` — could not tell: ${unknown.join(', ')}` : ''}`,
    );
  }
  return ready ? 0 : down.length ? 1 : 2;
}

async function waitReady(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      console.error(`app (pid ${pid}) exited during start — see work/logs/app.log`);
      return 1;
    }
    const info = readJson(APP_JSON);
    if (info?.pid === pid && Number.isInteger(info.port)) {
      const r = await request(`http://127.0.0.1:${info.port}/health`, { timeoutMs: 500 });
      if (answering(r)) {
        console.log(JSON.stringify({ ready: true, pid, port: info.port, bound: r.json.bound?.room_id ?? null }));
        return 0;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`app (pid ${pid}) not ready within ${ms} ms`);
  return 1;
}

/* ---------------------------------------------------------------- call -- */

// verb -> [method, path after /rooms/:room, needs an id]. The same table as tool.json.
const VERBS = {
  get_state: ['GET', '/state'], list_models: ['GET', '/models'], history: ['GET', '/history'],
  job_status: ['GET', '/jobs/:id', true], room_images: ['GET', '/room-images'], import_ref: ['POST', '/refs/import'], list_images: ['GET', '/images'], move_image: ['POST', '/images/move'], color_match: ['POST', '/images/colormatch'], to_art: ['POST', '/images/art'], crop_region: ['POST', '/images/crop'], paste_region: ['POST', '/images/paste'], set_model: ['POST', '/model'], set_prompt: ['POST', '/prompt'],
  set_params: ['POST', '/params'], set_ref: ['POST', '/refs'], clear_ref: ['POST', '/refs/clear'],
  generate: ['POST', '/generate'], cancel: ['POST', '/jobs/:id/cancel', true], reload_recipe: ['POST', '/recipe'],
  release_gpu: ['POST', '/gpu/release'],
  set_budget: ['POST', '/budget'],
  model_state: ['GET', '/models/state'], model_ops: ['GET', '/models/ops'], model_history: ['GET', '/models/history'],
  model_job_status: ['GET', '/models/jobs/:id', true], model_import: ['POST', '/models/import'], model_run: ['POST', '/models/run'],
  model_cancel: ['POST', '/models/jobs/:id/cancel', true], model_set_budget: ['POST', '/models/budget'],
  review_add: ['POST', '/reviews'], review_update: ['POST', '/reviews/update'], review_list: ['GET', '/reviews'],
  review_status: ['POST', '/reviews/status'], review_remove: ['POST', '/reviews/remove'], review_ref: ['POST', '/reviews/:n/refs', true],
  review_marks: ['GET', '/reviews/:n/marks', true], review_look: ['POST', '/reviews/:n/look', true],
};
const CALL_USAGE = `usage: scripts/studio.sh <verb> <room> [job-id]   (writes: JSON body on stdin, a quoted heredoc)
verbs: ${Object.keys(VERBS).join(' ')}`;

/* The resident's way in. Arguments are a verb, a room id and a job id; everything else
   (a prompt is room text — data, never shell) arrives as JSON on stdin. */
async function call(verb, room, id) {
  const v = VERBS[verb];
  if (!v || !room || (v[2] && !id)) {
    console.error(CALL_USAGE);
    return 64;
  }
  const s = await appState();
  if (s.state !== 'up') {
    console.error(`app is not up (${s.state}: ${s.reason}) — run scripts/start.sh`);
    return 1;
  }
  let body = null;
  if (v[0] === 'POST') {
    const raw = (await readStdin()).trim();
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      console.error('stdin is not JSON');
      return 64;
    }
  }
  const p = v[1].replace(/:id|:n/, encodeURIComponent(id ?? ''));
  const r = await request(`http://127.0.0.1:${s.port}/rooms/${encodeURIComponent(room)}${p}`, { method: v[0], body, timeoutMs: 15000 });
  console.log(r.error ? JSON.stringify({ ok: false, error: r.error }) : r.text.trim());
  return r.status >= 200 && r.status < 300 ? 0 : 1;
}

/* Look-and-judge: the verbs never return bytes, so the resident fetches an output itself
   and reads the file as an image. Ids only — validated — never a URL from room text. */
async function look(id) {
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    console.error('usage: scripts/look.sh <library-asset-id>');
    return 64;
  }
  const url = `${readConfig().libraryUrl}/assets/${encodeURIComponent(id)}/file`;
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    console.error(`could not fetch ${url} (${e.cause?.code || e.name})`);
    return 1;
  }
  if (!r.ok) {
    console.error(`${url} answered HTTP ${r.status}`);
    return 1;
  }
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[r.headers.get('content-type')?.split(';')[0]] || '.img';
  const dir = path.join(ROOT, 'work', 'look');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ext);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log(file);
  return 0;
}

/* Bind the app to ONE room (access: exclusive): this pane must hold a seat there. Records
   the room's name and this seat's handle — they go on every Library output as its origin. */
async function bind(roomArg) {
  if (!roomArg) {
    console.error('usage: scripts/bind.sh <room-id-or-name>');
    return 64;
  }
  const e = await engine('binding');
  if (e.error) {
    console.error(e.error);
    return 1;
  }
  const mine = await myRooms(e);
  if (mine.error) {
    console.error(`not binding: ${mine.error}`);
    return 1;
  }
  const hit = mine.rooms.find((x) => x.room.id === roomArg || x.room.name === roomArg);
  if (!hit) {
    console.error(`not binding: this pane holds no seat in an open room "${roomArg}"`);
    return 1;
  }
  const prev = readBinding();
  // paneid: the app posts outputs into the room's Assets AS this seat (the engine never
  // accepts a caller-declared author — rooms.ts authorFor).
  const b = { room_id: hit.room.id, room_name: hit.room.name, agent: hit.seat.handle ?? null, seat_id: hit.seat.id, paneid: e.paneid, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(BINDING), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(BINDING), 0o700);
  fs.writeFileSync(`${BINDING}.tmp`, JSON.stringify(b) + '\n', { mode: 0o600 });
  fs.renameSync(`${BINDING}.tmp`, BINDING);
  console.log(JSON.stringify({ ok: true, bound: b, ...(prev && prev.room_id !== b.room_id && { released: { room_id: prev.room_id, room_name: prev.room_name ?? null } }) }));
  return 0;
}

/* ------------------------------------------------------- engine (rooms) -- */

async function engine(what) {
  const paneid = process.env.HARBOR_WB_PANEID;
  if (!paneid) {
    return { error: `not ${what}: HARBOR_WB_PANEID is unset — without \`from\` the engine would record it as the user` };
  }
  const cfg = readConfig();
  const url = (process.env.HARBOR_WB_ENGINE_URL || cfg.engineUrl || '').trim().replace(/\/+$/, '');
  const tokenFile = (process.env.ASSET_STUDIO_ENGINE_TOKEN_FILE || cfg.engineTokenFile || '').trim();
  if (!url || !tokenFile) {
    return { error: `not ${what}: set engineUrl and engineTokenFile in config.local.json` };
  }
  let token;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (e) {
    return { error: `not ${what}: cannot read the engine token file (${e.code || e.message})` };
  }
  return { paneid, url, headers: { authorization: `Bearer ${token}` } };
}

/* The open rooms where THIS pane holds a seat: [{room, seat}]. */
async function myRooms(e) {
  const list = await request(`${e.url}/api/rooms`, { headers: e.headers, timeoutMs: 5000 });
  if (list.status !== 200 || !Array.isArray(list.json)) {
    return { error: `GET /api/rooms ${list.error ? `failed: ${list.error}` : `answered HTTP ${list.status}`}` };
  }
  const seatPane = (s) => (s?.occupant_kind === 'pane' ? (typeof s.occupant === 'string' ? s.occupant : s.occupant?.id) : null);
  const out = [];
  for (const x of list.json) {
    const seat = (x.seats || []).find((s) => seatPane(s) === e.paneid);
    if (x.room?.state === 'open' && seat) {
      out.push({ room: x.room, seat });
    }
  }
  return { rooms: out };
}

/* The fallback when fabric-mcp's room_post is not available. The body is built
   here, never by a shell, and always carries `from`: without it the engine
   records the line as the user (briefing-table docs/workrooms-build.md §2.2). */
async function post(roomArg, text) {
  const e = await engine('posting');
  if (e.error) {
    console.error(e.error);
    return 1;
  }
  const mine = await myRooms(e);
  if (mine.error) {
    console.error(`not posting: ${mine.error}`);
    return 1;
  }
  const pick = roomArg ? mine.rooms.filter((x) => x.room.id === roomArg || x.room.name === roomArg) : mine.rooms;
  if (pick.length !== 1) {
    const rooms = JSON.stringify(mine.rooms.map((x) => ({ id: x.room.id, name: x.room.name })));
    console.error(`not posting: ${pick.length ? 'several rooms match — name one' : `this pane holds no seat in ${roomArg ? `an open room "${roomArg}"` : 'an open room'}`}; your rooms: ${rooms}`);
    return 1;
  }
  const { room } = pick[0];
  const r = await request(`${e.url}/api/rooms/${encodeURIComponent(room.id)}/line`, {
    method: 'POST',
    body: { text, from: { paneid: e.paneid } },
    headers: e.headers,
    timeoutMs: 5000,
  });
  console.log(JSON.stringify({ room: { id: room.id, name: room.name }, http: r.status ?? null, ...(r.json ?? { error: r.error ?? r.text }) }));
  return r.status >= 200 && r.status < 300 && r.json?.status !== 'refused' ? 0 : 1;
}

/* Register this room's panel on this pane's seat (tool-residents §2.6). A
   panel's url cannot be PATCHed, and the app's port can change on restart, so
   this REPLACES: it removes this seat's earlier Asset Studio panels for the room
   (same view path, any port) and adds one at the current port. Idempotent. */
const APP_SLUG = 'asset-studio';
const PANEL_TITLE = 'Asset Studio';
async function registerPanel(roomArg) {
  if (!roomArg) {
    console.error('usage: scripts/register-panel.sh <room-id>');
    return 64;
  }
  const s = await appState();
  if (s.state !== 'up') {
    console.error(`not registering: app is not up (${s.state}: ${s.reason}) — run scripts/start.sh first`);
    return 1;
  }
  const e = await engine('registering');
  if (e.error) {
    console.error(e.error);
    return 1;
  }
  const mine = await myRooms(e);
  if (mine.error) {
    console.error(`not registering: ${mine.error}`);
    return 1;
  }
  const hit = mine.rooms.find((x) => x.room.id === roomArg || x.room.name === roomArg);
  if (!hit) {
    console.error(`not registering: this pane holds no seat in an open room "${roomArg}"`);
    return 1;
  }
  const { room, seat } = hit;
  const viewPath = `/rooms/${encodeURIComponent(room.id)}/view`;
  const panelsUrl = `${e.url}/api/rooms/${encodeURIComponent(room.id)}/panels`;
  const listed = await request(panelsUrl, { headers: e.headers, timeoutMs: 5000 });
  if (listed.status !== 200 || !Array.isArray(listed.json?.panels)) {
    console.error(`not registering: GET panels ${listed.error ? `failed: ${listed.error}` : `answered HTTP ${listed.status}`}`);
    return 1;
  }
  // The room already holds the app (Settings → Apps / the + sheet): the apps flow owns its panel (app_slug,
  // seat cleared by design), so don't add a second one. Only clear OUR leftovers: seat-owned, no app_slug,
  // same view (briefing-table a self-registered twin appeared after the r37 adoption).
  const apps = await request(`${e.url}/api/rooms/${encodeURIComponent(room.id)}/apps`, { headers: e.headers, timeoutMs: 5000 });
  const held = apps.status === 200 && Array.isArray(apps.json?.apps) ? apps.json.apps.find((x) => x.slug === APP_SLUG) : null;
  const removed = [];
  for (const p of listed.json.panels) {
    let same = false;
    try {
      const u = new URL(p.url);
      same = !p.app_slug && p.seat_id === seat.id && p.title === PANEL_TITLE && u.hostname === '127.0.0.1' && u.pathname === viewPath; // title too: sibling apps share the /rooms/<id>/view path
    } catch {
      /* not ours */
    }
    if (same) {
      const d = await request(`${panelsUrl}/${encodeURIComponent(p.id)}`, { method: 'DELETE', body: { from: { paneid: e.paneid } }, headers: e.headers, timeoutMs: 5000 });
      removed.push({ id: p.id, http: d.status ?? d.error });
    }
  }
  if (held) {
    console.log(JSON.stringify({ room: { id: room.id, name: room.name }, removed, mounted_by_room: held.panel_ids ?? [] }));
    return 0;
  }
  const r = await request(panelsUrl, {
    method: 'POST',
    // scripts:true — view.js polls panel.json and talks to the host (height, count,
    // preview); the engine grants the iframe allow-scripts for it, never allow-same-origin.
    body: { title: PANEL_TITLE, url: `http://127.0.0.1:${s.port}${viewPath}`, icon: 'image', scripts: true, from: { paneid: e.paneid } },
    headers: e.headers,
    timeoutMs: 5000,
  });
  console.log(JSON.stringify({ room: { id: room.id, name: room.name }, removed, http: r.status ?? null, ...(r.json ?? { error: r.error ?? r.text }) }));
  return (r.status >= 200 && r.status < 300) || r.status === 409 ? 0 : 1; // 409 = that view is already mounted in the room
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks = [];
  for await (const c of process.stdin) {
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const [cmd, ...args] = process.argv.slice(2);
let code;
switch (cmd) {
  case 'status': {
    const s = await appState();
    if (args.includes('--publish')) {
      publish(s);
    }
    console.log(JSON.stringify(s));
    code = 0;
    break;
  }
  case 'preflight':
    code = await preflight(args.includes('--json'));
    break;
  case 'instances': {
    const found = instancesOf(APP_MAIN);
    if (found === null) {
      console.error('cannot read the process table (/proc)');
      code = 2;
    } else {
      found.forEach((p) => console.log(p));
      code = 0;
    }
    break;
  }
  case 'clear-stale':
    code = clearStale();
    break;
  case 'wait-ready':
    code = await waitReady(Number(args[0]), Number(args[1] ?? 5000));
    break;
  case 'call':
    code = await call(...args);
    break;
  case 'bind':
    code = await bind(args[0]);
    break;
  case 'look':
    code = await look(args[0]);
    break;
  case 'register-panel':
    code = await registerPanel(args[0]);
    break;
  case 'post': {
    const text = (await readStdin()).trim();
    code = text ? await post(args[0], text) : (console.error("usage: scripts/post.sh [room] <<'LINE' … LINE"), 64);
    break;
  }
  case 'rooms': {
    const e = await engine('listing rooms');
    const mine = e.error ? e : await myRooms(e);
    if (mine.error) {
      console.error(mine.error);
      code = 1;
    } else {
      console.log(JSON.stringify(mine.rooms.map((x) => ({ id: x.room.id, name: x.room.name, seat: x.seat.id, handle: x.seat.handle ?? null }))));
      code = 0;
    }
    break;
  }
  default:
    console.error('usage: tool.mjs status [--publish] | preflight [--json] | instances | clear-stale | wait-ready <pid> <ms> | call <verb> <room> [id] | look <asset-id> | bind <room> | register-panel <room> | post [room] | rooms');
    code = 64;
}
process.exit(code);
