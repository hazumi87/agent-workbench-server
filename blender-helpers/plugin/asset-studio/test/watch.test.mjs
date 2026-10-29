/*
 * Watch routes probe (from Model Studio's test/watch.test.mjs, part 1). Run: npm test
 *
 * Like the API tests it works on a COPY of the tool in a temp dir, with every outside party stubbed on
 * one loopback server: the FILE SHARE (index.json, <job>/manifest.json, frames, looks, model/latest.glb
 * and the modes-demo job's model/reference.glb — generated here) and an empty core / image-gen / Library
 * / engine / file-share. The env is scrubbed of HARBOR_WB_* / ASSET_STUDIO_* / FABRIC_*. It checks the
 * app's Watch routes: names strictly checked, share failures, timeouts.
 *
 * Model Studio's part 2 (the Watch tab driven in headless Chromium) is not here yet: Asset Studio's
 * panel (app/static/view.js) has no Watch tab to drive. Port it from model-studio's test once it does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-studio-watch-')));
const BINDING_FILE = path.join(ROOT, 'state', 'binding.json');
const ROOM = '3f2a9c10-aaaa-bbbb-cccc-000000000001';
const OTHER = '9e8d7c6b-aaaa-bbbb-cccc-000000000002';
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARBOR_WB_|ASSET_STUDIO_|FABRIC_)/.test(k)));
const SHARE = '/share/raw/rooms/test-room/model-studio-live';

/* ------------------------------------------------------------ the fixture -- */

const CAMS = [
  { id: 'front', label: 'Front', position: [0, 0.5, 4], target: [0, 0, 0], fov: 35 },
  { id: 'side', label: 'Side', position: [4, 0.5, 0.5], target: [0, 0, 0], fov: 50 },
  { id: 'top', label: 'Top' },
  { id: 'agent', label: 'Agent' },
];
const AGENT_STEPS = [3, 6]; // the agent camera only exists on steps where the agent rendered something
const VERBS = ['import', 'kit2_part', 'bevel', 'kit2_part'];
const T0 = Date.parse('2026-10-01T03:40:00Z');
const share = { index: false, down: false, hang: false, paths: [], steps: 8, modelStep: 5 };
const NS = [1, 2, 3, 4, 5, 6, 7, 14, 15, 16]; // step numbers are NOT contiguous
const mkStep = (i) => ((n) => ({
  n, verb: VERBS[n % 4], at: new Date(T0 + n * 60000).toISOString(), note: `placed part_${n}`,
  frames: Object.fromEntries(['front', 'side', 'top'].concat(AGENT_STEPS.includes(n) ? ['agent'] : []).map((c) => [c, `frames/${c}/${n}.jpg`])),
}))(NS[i]);
const manifest = () => ({
  job: 'character-kit-v3', updated: new Date(T0 + share.steps * 60000).toISOString(), latest: NS[share.steps - 1], cameras: CAMS,
  steps: Array.from({ length: share.steps }, (_, i) => mkStep(i)),
  model: { file: 'model/latest.glb', step: share.modelStep },
});
/* the NEW shape: display modes. frames[camera] is {mode: path}. "front" lacks wire at step 4; "side" has nothing at step 6;
   "agent" renders plain only, at steps 2 and 5 */
const MODES = [{ id: 'plain', label: 'Plain', short: 'Plain' }, { id: 'color', label: 'Colour on grey reference', short: 'A' }, { id: 'wire', label: 'Wireframe on see-through reference', short: 'B' }, { id: 'refwire', label: 'Grey on reference wireframe', short: 'C' }];
const MODE_CAMS = [{ id: 'front', label: 'Front' }, { id: 'side', label: 'Side' }, { id: 'agent', label: "Agent's view" }];
const modeFrames = (n) => Object.fromEntries(MODE_CAMS.map((c) => c.id).map((id) => {
  if (id === 'agent') return n === 2 || n === 5 ? [id, { plain: `frames/${id}/plain/${n}.jpg` }] : null;
  if (id === 'side' && n === 6) return null;
  return [id, Object.fromEntries(MODES.map((m) => m.id).filter((m) => !(id === 'front' && m === 'wire' && n === 4)).map((m) => [m, `frames/${id}/${m}/${n}.jpg`]))];
}).filter(Boolean));
/* looks: pictures the operator opened itself, per step. Step 3 has two (the second has no wide companion), step 5 has twelve */
const look = (n, label, ms, wide = true) => ({ file: `looks/${n}/${label}-${ms}.jpg`, wide: wide ? `looks/${n}/${label}-${ms}-wide.jpg` : null, at: new Date(T0 + ms).toISOString(), label });
const LOOKS = { 3: [look(3, 'a2-front-plain', 1000), look(3, 'review-front', 1100, false)], 5: Array.from({ length: 12 }, (_, i) => look(5, `part-${i + 1}`, 2000 + i)) };
const lookFiles = (n) => (LOOKS[n] ?? []).flatMap((l) => [l.file, l.wide].filter(Boolean));
const modesJob = () => ({
  job: 'modes-demo', updated: new Date(T0 + 6 * 60000).toISOString(), latest: 6, cameras: MODE_CAMS, modes: MODES.map((m) => (m.id === 'wire' ? { ...m, alpha: 0.4 } : m)),
  reference: { file: 'model/reference.glb', solid: 'ref', grid: 'ref-grid' },
  steps: [1, 2, 3, 4, 5, 6].map((n) => ({ n, verb: 'kit2_part', at: new Date(T0 + n * 60000).toISOString(), note: `mode step ${n}`, frames: modeFrames(n), ...(LOOKS[n] && { looks: LOOKS[n] }) })),
  model: { file: 'model/latest.glb', step: share.modelStep },
});
const JOBS = { 'character-kit-v3': manifest, 'modes-demo': modesJob };
const index = () => ({ jobs: [['character-kit-v3', share.steps], ['modes-demo', 6], ['modes-auto', 2], ['many-cams', 2], ['character-kit-v2', 2], ['blank-job', 0]].map(([job, steps]) => ({ job, updated: new Date(T0).toISOString(), steps })) });

let JPG = null; // one real JPEG, made in before()
/* a minimal binary glTF (header + JSON chunk): the routes only pass bytes through */
function glb(name) {
  let js = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name }] }));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), c1 = Buffer.alloc(8);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length, 8);
  c1.writeUInt32LE(js.length, 0); c1.write('JSON', 4);
  return Buffer.concat([head, c1, js]);
}

function stub() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!u.pathname.startsWith(`${SHARE}/`)) return json(404, { error: 'stub: nothing here' }); // core / image-gen / Library / engine: all absent
    if (share.hang) return; // never answers
    if (share.down) return req.socket.destroy();
    const rel = u.pathname.slice(SHARE.length + 1);
    share.paths.push(rel);
    if (rel === 'index.json') return share.index ? json(200, index()) : json(404, { error: 'no index' });
    let m = rel.match(/^([^/]+)\/manifest\.json$/);
    if (m) return JOBS[m[1]] ? json(200, JOBS[m[1]]()) : json(404, { error: 'no job' });
    m = rel.match(/^([^/]+)\/frames\/([^/]+)\/(?:([^/]+)\/)?(\d+)\.jpg$/);
    if (m) {
      const man = JOBS[m[1]]?.();
      const ok = man && man.steps.some((s) => { const f = s.frames[m[2]]; return s.n === Number(m[4]) && (typeof f === 'string' ? !m[3] : m[3] && f?.[m[3]]); });
      if (!ok) return json(404, { error: 'no frame' });
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPG);
    }
    m = rel.match(/^modes-demo\/(looks\/(\d+)\/[^/]+\.jpg)$/);
    if (m) {
      if (!lookFiles(Number(m[2])).includes(m[1])) return json(404, { error: 'no look' });
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPG);
    }
    if (/^[^/]+\/model\/reference\.glb$/.test(rel)) { // only modes-demo has one
      if (!rel.startsWith('modes-demo/')) return json(404, { error: 'no reference' });
      const b = glb('ref');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length });
      return res.end(b);
    }
    if (/^[^/]+\/model\/latest\.glb$/.test(rel)) {
      const b = glb('body');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length });
      return res.end(b);
    }
    json(404, { error: 'stub: unknown' });
  });
}

/* --------------------------------------------------------------- harness -- */

let srv, app, base;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const room = (p) => `/rooms/${ROOM}${p}`;
const get = async (p, init) => {
  const r = await fetch(base + p, init);
  return { status: r.status, headers: r.headers, json: await r.clone().json().catch(() => null), buf: Buffer.from(await r.arrayBuffer()) };
};
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
};

before(async () => {
  for (const d of ['app', 'scripts', 'test']) fs.cpSync(path.join(SRC, d), path.join(ROOT, d), { recursive: true });
  for (const f of ['tool.json', 'config.example.json']) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  fs.mkdirSync(path.join(ROOT, 'status'), { recursive: true });
  const jpg = path.join(ROOT, 'frame.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3b6fb6:s=64x36', '-frames:v', '1', jpg]);
  JPG = fs.readFileSync(jpg);
  const port = await listen((srv = stub()));
  const S = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(ROOT, 'engine.token'), 'stub-engine-token\n');
  fs.writeFileSync(path.join(ROOT, 'config.local.json'), JSON.stringify({
    coreUrl: `${S}/core/api`, imageGenUrl: `${S}/ig/api`, libraryUrl: `${S}/lib`, shareUrl: `${S}/share`, libraryStaging: path.join(ROOT, 'staging'),
    engineUrl: S, engineTokenFile: path.join(ROOT, 'engine.token'), port: 0, defaultBudget: 3, defaultModelBudget: 3,
  }));
  fs.mkdirSync(path.dirname(BINDING_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(BINDING_FILE, JSON.stringify({ room_id: ROOM, room_name: 'Test Room', agent: 'asset-platform', seat_id: 'seat-1', paneid: 'pane-1', at: '2026-09-29T00:00:00Z' }), { mode: 0o600 });
  app = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
    cwd: ROOT, env: { ...BASE_ENV, ASSET_STUDIO_BINDING: BINDING_FILE, ASSET_STUDIO_WATCH_BASE: `${S}${SHARE}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appJson = path.join(ROOT, 'status', 'app.json');
  const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(appJson, 'utf8')).port; } catch { return 0; } });
  base = `http://127.0.0.1:${p}`;
});

after(() => {
  app?.kill('SIGTERM');
  srv?.close();
  srv?.closeAllConnections?.();
});

/* ------------------------------------------------------------ the app's routes -- */

test('watch.json: no index on the share is the normal empty state (jobs: [], no error)', async () => {
  const r = await get(room('/watch.json'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, jobs: [] });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await get(room('/watch.json?job=character-kit-v3'))).json.ok, true, 'a manifest is read whether or not the index is there');
});

test('watch.json: the job list, one job\'s manifest (ETag → 304), 404 for a missing job', async () => {
  share.index = true;
  const r = await get(room('/watch.json'));
  assert.deepEqual(r.json.jobs.map((j) => j.job), ['character-kit-v3', 'modes-demo', 'modes-auto', 'many-cams', 'character-kit-v2', 'blank-job']);
  assert.equal(r.json.jobs[0].steps, 8);
  const m = await get(room('/watch.json?job=character-kit-v3'));
  assert.equal(m.status, 200);
  assert.equal(m.json.ok, true);
  assert.equal(m.json.steps.length, 8);
  assert.deepEqual(m.json.cameras.map((c) => c.id), ['front', 'side', 'top', 'agent']);
  assert.deepEqual(m.json.cameras[0].position, [0, 0.5, 4], 'poses pass through');
  assert.equal((await get(room('/watch.json?job=character-kit-v3'), { headers: { 'if-none-match': m.headers.get('etag') } })).status, 304);
  const gone = await get(room('/watch.json?job=nope'));
  assert.equal(gone.status, 404);
  assert.equal(gone.json.ok, false);
});

test('names are strictly checked: anything else is 400 and never reaches the share', async () => {
  const before = share.paths.length;
  for (const p of [
    '/watch.json?job=', '/watch.json?job=Bad_Job', '/watch.json?job=-x', '/watch.json?job=..', '/watch.json?job=a%2Fb', `/watch.json?job=${'a'.repeat(65)}`,
    '/watch/Bad/frame/front/1.jpg', '/watch/character-kit-v3/frame/Front/1.jpg', '/watch/character-kit-v3/frame/fr%2Font/1.jpg', '/watch/character-kit-v3/frame/front/x.jpg',
    '/watch/character-kit-v3/frame/front/Wire/1.jpg', '/watch/character-kit-v3/frame/front/w%2Fre/1.jpg', '/watch/character-kit-v3/frame/front/..%2f/1.jpg', `/watch/character-kit-v3/frame/front/${'m'.repeat(33)}/1.jpg`, '/watch/character-kit-v3/frame/front/wire/x.jpg', '/watch/character-kit-v3/frame/front/wire/1.png',
    '/watch/character-kit-v3/frame/front/1.png', '/watch/character-kit-v3/frame/front/-1.jpg', '/watch/character-kit-v3/frame/front/1e3.jpg', `/watch/character-kit-v3/frame/${'c'.repeat(33)}/1.jpg`,
    '/watch/..%2f..%2fetc/model.glb', '/watch/Upper/model.glb', '/watch/..%2f/frame/front/1.jpg',
    '/watch/Bad/reference.glb', '/watch/..%2f..%2fetc/reference.glb', '/watch/Upper/reference.glb', `/watch/${'a'.repeat(65)}/reference.glb`,
  ]) {
    const r = await get(room(p));
    assert.equal(r.status, 400, p);
    assert.equal(r.json.ok, false, p);
  }
  assert.equal(share.paths.length, before, 'no bad name was ever forwarded to the share');
  assert.equal((await get(room('/watch/character-kit-v3/frame/front/1.jpg'), { method: 'POST' })).status, 405, 'GET-only');
  assert.equal((await get(`/rooms/${OTHER}/watch.json`)).json.ok, false, 'another room gets the message, never the share');
});

test('frames stream with a long cache; the model is no-cache; a missing frame is 404', async () => {
  const f = await get(room('/watch/character-kit-v3/frame/side/3.jpg'));
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/jpeg');
  assert.match(f.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(f.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(f.buf.subarray(0, 2), Buffer.from([0xff, 0xd8]), 'real JPEG bytes');
  assert.equal((await get(room('/watch/character-kit-v3/frame/side/99.jpg'))).status, 404);
  assert.equal((await get(room('/watch/character-kit-v3/frame/agent/2.jpg'))).status, 404, 'not every step has every camera');
  const m = await get(room('/watch/character-kit-v3/model.glb?step=5'));
  assert.equal(m.status, 200);
  assert.equal(m.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(m.headers.get('cache-control'), 'no-cache');
  assert.equal(m.buf.subarray(0, 4).toString(), 'glTF');
});

test('reference: watch/<job>/reference.glb serves the job\'s model/reference.glb like model.glb (revalidated, GET-only); a job without one is 404', async () => {
  const r = await get(room('/watch/modes-demo/reference.glb'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.buf.subarray(0, 4).toString(), 'glTF');
  assert.ok(share.paths.includes('modes-demo/model/reference.glb'), 'forwarded as <job>/model/reference.glb');
  const none = await get(room('/watch/character-kit-v3/reference.glb'));
  assert.equal(none.status, 404, 'the share has none for this job');
  assert.equal(none.json.ok, false);
  assert.equal((await get(room('/watch/character-kit-v3/model.glb'))).status, 200, 'the model route is as it was');
  assert.equal((await get(room('/watch/modes-demo/reference.glb'), { method: 'POST' })).status, 405, 'GET-only');
});

test('display modes: watch/<job>/frame/<camera>/<mode>/<n>.jpg serves the mode\'s JPEG; the old route still serves the old shape; the manifest carries the modes', async () => {
  const f = await get(room('/watch/modes-demo/frame/front/wire/6.jpg'));
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/jpeg');
  assert.match(f.headers.get('cache-control'), /max-age=31536000/);
  assert.deepEqual(f.buf.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.ok(share.paths.includes('modes-demo/frames/front/wire/6.jpg'), 'forwarded as <job>/frames/<camera>/<mode>/<n>.jpg');
  assert.equal((await get(room('/watch/modes-demo/frame/front/wire/4.jpg'))).status, 404, 'a camera can lack a mode at a step');
  assert.equal((await get(room('/watch/character-kit-v3/frame/side/3.jpg'))).status, 200, 'the old route is unchanged');
  const m = (await get(room('/watch.json?job=modes-demo'))).json;
  assert.deepEqual(m.modes.map((x) => x.id), ['plain', 'color', 'wire', 'refwire']);
  assert.deepEqual(m.steps[1].frames.agent, { plain: 'frames/agent/plain/2.jpg' });
});

test('looks: watch/<job>/look/<n>/<file>.jpg serves the operator\'s picture from <job>/looks/<n>/, cached for good; the manifest carries the looks unchanged', async () => {
  const f = await get(room('/watch/modes-demo/look/3/a2-front-plain-1000.jpg'));
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/jpeg');
  assert.match(f.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(f.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(f.buf.subarray(0, 2), Buffer.from([0xff, 0xd8]), 'real JPEG bytes');
  assert.ok(share.paths.includes('modes-demo/looks/3/a2-front-plain-1000.jpg'), 'forwarded as <job>/looks/<n>/<file>');
  assert.equal((await get(room('/watch/modes-demo/look/3/a2-front-plain-1000-wide.jpg'))).status, 200, 'the wide companion is a look file too');
  assert.equal((await get(room('/watch/modes-demo/look/3/nope-1.jpg'))).status, 404, 'a picture the share does not have');
  assert.equal((await get(room('/watch/modes-demo/look/4/a2-front-plain-1000.jpg'))).status, 404, 'a look belongs to its own step');
  assert.equal((await get(room('/watch/character-kit-v3/look/3/a2-front-plain-1000.jpg'))).status, 404, 'and to its own job');
  const m = (await get(room('/watch.json?job=modes-demo'))).json;
  assert.deepEqual(m.steps[2].looks, LOOKS[3], 'looks pass through as the share wrote them');
  assert.equal(m.steps[4].looks.length, 12);
  assert.equal(m.steps[0].looks, undefined, 'a step without looks has none');
  assert.equal((await get(room('/watch.json?job=character-kit-v3'))).json.steps.some((x) => 'looks' in x), false, 'an old manifest is untouched');
});

test('look names are strictly checked: bad step, bad file name, traversal are 400 and never reach the share', async () => {
  const before = share.paths.length;
  for (const p of [
    '/watch/Bad/look/3/a.jpg', '/watch/modes-demo/look/x/a.jpg', '/watch/modes-demo/look/-1/a.jpg', '/watch/modes-demo/look/1e3/a.jpg', '/watch/modes-demo/look/3.5/a.jpg', `/watch/modes-demo/look/${'9'.repeat(10)}/a.jpg`,
    '/watch/modes-demo/look/3/a.png', '/watch/modes-demo/look/3/a', '/watch/modes-demo/look/3/.jpg', '/watch/modes-demo/look/3/a.JPG', '/watch/modes-demo/look/3/a..b.jpg', '/watch/modes-demo/look/3/..jpg', '/watch/modes-demo/look/3/a%20b.jpg',
    '/watch/modes-demo/look/3/..%2f..%2fmanifest.jpg', '/watch/modes-demo/look/3/%2e%2e%2fmanifest.jpg', '/watch/modes-demo/look/3/a%2fb.jpg', '/watch/modes-demo/look/3/a%5cb.jpg', '/watch/modes-demo/look/3/a%00.jpg', `/watch/modes-demo/look/3/${'a'.repeat(161)}.jpg`,
  ]) {
    const r = await get(room(p));
    assert.equal(r.status, 400, p);
    assert.equal(r.json.ok, false, p);
  }
  assert.equal(share.paths.length, before, 'no bad name was ever forwarded to the share');
  assert.equal((await get(room('/watch/modes-demo/look/3/a2-front-plain-1000.jpg'), { method: 'POST' })).status, 405, 'GET-only');
});

test('a share that is down or slow never takes the app with it', async () => {
  share.down = true;
  const r = await get(room('/watch.json'));
  assert.equal(r.status, 200);
  assert.equal(r.json.jobs.length, 0);
  assert.match(r.json.error, /unreachable/);
  assert.equal((await get(room('/watch.json?job=character-kit-v3'))).status, 503);
  assert.equal((await get(room('/watch/character-kit-v3/frame/side/3.jpg'))).status, 503);
  share.down = false;
  share.hang = true;
  const t0 = Date.now();
  const slow = await get(room('/watch.json'));
  assert.match(slow.json.error, /too slow/);
  assert.ok(Date.now() - t0 < 8000, 'the 5 s timeout, not forever');
  share.hang = false;
  assert.equal((await get('/health')).json.ok, true, 'the app is still up');
  assert.equal((await get(room('/watch.json'))).json.jobs.length, 6, 'and the share is read again once it is back');
});

test('phone cameras (): on tiers S and M the numbered camera buttons are hidden and one ‹ | › steps through the cameras (left/right, wrapping); the panel carries both', async () => {
  const js = (await get(room('/view.js'))).buf.toString('utf8');
  assert.match(js, /data-wcamstep/, 'the ‹ | › buttons carry the step');
  assert.match(js, /'Previous camera'/);
  assert.match(js, /'Next camera'/);
  assert.match(js, /mv && !poseOf\(cand\)/, 'in the 3D view only cameras with a saved view are visited');
  const html = (await get(room('/watch/modes-demo'))).buf.toString('utf8');
  assert.match(html, /\.t-s \.mdl \.wt-cb,\.t-m \.mdl \.wt-cb\{display:none\}/, 'no row of numbers on a phone');
  assert.match(html, /\.t-s \.mdl \.wt-cnav,\.t-m \.mdl \.wt-cnav\{display:flex\}/);
  assert.match(html, /\.mdl \.wt-cnav\{display:none;/, 'and none on a wide panel');
});
