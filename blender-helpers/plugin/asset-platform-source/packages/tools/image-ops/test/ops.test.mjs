// image-ops tests — node --test (from packages/tools/image-ops: `node --test test/`).
// A STUB Library (GET /assets/:id + /file, POST /assets) stands in for asset-library; the tool
// runs on an ephemeral express app. Fixtures are drawn with ffmpeg lavfi.
// vtracer: set IMAGE_OPS_PYTHON to a python with `vtracer` installed, else that case asserts 503.
// remove_bg: runs for real only when that python has `rembg` AND IMAGE_OPS_MODEL_DIR holds
// birefnet-general-lite (see remove_bg.py --fetch); otherwise it asserts the 503 + hint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';

const FACE_FIXTURES = process.env.IMAGE_OPS_FACE_FIXTURES && existsSync(path.join(process.env.IMAGE_OPS_FACE_FIXTURES, 'source.png')) ? process.env.IMAGE_OPS_FACE_FIXTURES : null;
const tmp = mkdtempSync(path.join(tmpdir(), 'image-ops-test-'));
const patched = [];                // every PATCH /assets/:id the stub received
const posted = [];                 // every POST /assets the stub received (+ the file bytes)
const assets = new Map();          // id → { row, file }
let lib, tool, TOOL_URL, BASE;

function draw(name, lavfi) {
  const out = path.join(tmp, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', out]);
  return out;
}
const listen = (app) => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

before(async () => {
  // icon: black disc + a lower arc on white (256²)
  const icon = draw('icon.png', "color=white:s=256x256,format=gray,geq=lum='if(lt(hypot(X-128\\,Y-128)\\,60)\\,0\\,if(between(hypot(X-128\\,Y-128)\\,80\\,92)*gt(Y\\,128)\\,0\\,255))'");
  // three colours: red disc + blue box on white (240²)
  const disc = 'lt(hypot(X-80\\,Y-120)\\,50)', box = 'between(X\\,140\\,210)*between(Y\\,60\\,180)';
  const tri = draw('tri.png', `color=white:s=240x240,format=rgb24,geq=r='if(${disc}\\,220\\,if(${box}\\,20\\,255))':g='if(${disc}\\,30\\,if(${box}\\,40\\,255))':b='if(${disc}\\,30\\,if(${box}\\,200\\,255))'`);
  // transparency: black disc on a transparent 200×100 canvas
  const alpha = draw('alpha.png', "color=black@0:s=200x100,format=rgba,geq=r=0:g=0:b=0:a='if(lt(hypot(X-50\\,Y-50)\\,40)\\,255\\,0)'");
  // faint line art: light-grey (205) ring + bar on off-white (228) — low contrast (256²)
  const faint = draw('faint.png', "color=white:s=256x256,format=gray,geq=lum='if(between(hypot(X-128\\,Y-128)\\,70\\,74)+between(Y\\,40\\,43)\\,205\\,228)'");
  // the same over gentle shading + grain — what a painted image looks like to CLAHE
  const shaded = draw('shaded.png', "color=white:s=256x256,format=gray,geq=lum='if(between(hypot(X-128\\,Y-128)\\,70\\,74)+between(Y\\,40\\,43)\\,200\\,222)+X/16',noise=alls=4:all_seed=3");
  const flat = draw('flat.png', 'color=0x808080:s=64x64,format=rgb24');
  // ramps: brightness grows to the right / downward
  const hramp = draw('hramp.png', "color=black:s=128x64,format=gray,geq=lum='X*2'");
  const vramp = draw('vramp.png', "color=black:s=64x128,format=gray,geq=lum='Y*2'");
  // a smooth texture that does NOT tile (200×160)
  const wave = draw('wave.png', "color=black:s=200x160,format=rgb24,geq=r='128+80*sin(X/23)':g='128+60*cos(Y/17)':b='100+X/2'");
  // a noisy texture (bumps) for height / AO
  const noisy = draw('noisy.png', "color=0x808080:s=128x128,format=gray,noise=alls=60:all_seed=7");
  // fill: on white (200²) a red disc (220,30,30) r<40 at (60,100) inside a closed black ring r 50..56,
  // and a second, slightly darker red disc (200,30,30) r<25 at (160,100) — 20 off the first
  const d1 = 'lt(hypot(X-60\\,Y-100)\\,40)', d2 = 'lt(hypot(X-160\\,Y-100)\\,25)', ring = 'between(hypot(X-60\\,Y-100)\\,50\\,56)';
  const paint = draw('paint.png', `color=white:s=200x200,format=rgb24,geq=r='if(${d1}\\,220\\,if(${d2}\\,200\\,if(${ring}\\,0\\,255)))':g='if(${d1}+${d2}\\,30\\,if(${ring}\\,0\\,255))':b='if(${d1}+${d2}\\,30\\,if(${ring}\\,0\\,255))'`);
  const wav = path.join(tmp, 'a.wav');
  if (FACE_FIXTURES) {          // optional real photos: IMAGE_OPS_FACE_FIXTURES=<dir with source.png, same.png, other.png>
    for (const n of ['source', 'same', 'other']) {
      assets.set(`face-${n}`, { row: { id: `face-${n}`, category: 'image', subtype: 'image', label: n, filename: `${n}.png`, transient: 1, meta: {} }, file: path.join(FACE_FIXTURES, `${n}.png`) });
    }
  }
  for (const [id, file, category] of [['icon', icon, 'image'], ['tri', tri, 'image'], ['alpha', alpha, 'image'], ['wav', wav, 'audio'],
    ['faint', faint, 'image'], ['shaded', shaded, 'image'], ['flat', flat, 'image'], ['hramp', hramp, 'image'], ['vramp', vramp, 'image'], ['wave', wave, 'image'], ['noisy', noisy, 'image'], ['paint', paint, 'image']]) {
    assets.set(id, { row: { id, category, subtype: category, label: id, filename: path.basename(file), transient: 1, meta: {} }, file });
  }

  const stub = express();
  stub.use(express.json());
  stub.get('/api/assets/:id', (req, res) => {
    const a = assets.get(req.params.id);
    a ? res.json(a.row) : res.status(404).json({ error: 'not found' });
  });
  stub.get('/api/assets/:id/file', (req, res) => res.sendFile(assets.get(req.params.id).file));
  stub.patch('/api/assets/:id', (req, res) => {
    patched.push({ id: req.params.id, body: req.body });
    res.json({ ok: true });
  });
  stub.post('/api/assets', (req, res) => {
    const b = req.body;
    assert.ok(existsSync(b.srcPath), 'srcPath exists at POST time');
    posted.push({ ...b, bytes: readFileSync(b.srcPath) });
    res.json({ ok: true, asset: { id: `out${posted.length}`, category: 'image', ...b } });
  });
  lib = await listen(stub);

  process.env.IMAGE_OPS_LIBRARY_URL = `http://127.0.0.1:${lib.address().port}/api`;
  process.env.IMAGE_OPS_WORK = path.join(tmp, 'work');
  const mod = await import('../server.js');
  BASE = mod.BASE;
  const app = express();
  await mod.register(app);          // ROOT-independent: the gateway-boot check
  tool = await listen(app);
  TOOL_URL = `http://127.0.0.1:${tool.address().port}${BASE}/api`;
});

after(() => { tool?.close(); lib?.close(); rmSync(tmp, { recursive: true, force: true }); });

async function op(name, body) {
  const r = await fetch(`${TOOL_URL}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
// Runs an op that must succeed; returns the response + the registered file's details.
async function ok(name, body) {
  const r = await op(name, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = posted.at(-1);
  assert.equal(p.parent_id, body.asset_id);
  assert.equal(p.source, 'image-ops');
  assert.equal(p.transient, true);
  assert.deepEqual(p.derived_op, { tool: 'image-ops', op: name, params: r.body.params });
  assert.equal(r.body.op, name);
  if (p.filename.endsWith('.png')) {
    assert.deepEqual([...p.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'valid PNG');
    return { ...r, post: p, meta: await sharp(p.bytes).metadata() };
  }
  assert.ok(p.filename.endsWith('.svg'));
  assert.equal(p.subtype, 'svg');
  const svg = p.bytes.toString('utf8');
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<svg[^>]*viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg, /<svg[^>]*\swidth=/, 'removeDimensions');
  await sharp(p.bytes).metadata();     // librsvg parses it
  return { ...r, post: p, svg };
}

test('catalogue lists every op with params, defaults and ranges', async () => {
  const c = await (await fetch(`${TOOL_URL}/ops`)).json();
  const names = c.ops.map(o => o.name);
  assert.deepEqual(names, ['crop', 'trim', 'flip', 'rotate', 'resize', 'pad', 'threshold', 'invert', 'fill',
    'levels', 'local_contrast', 'sharpen', 'blur', 'posterize', 'edges', 'remove_bg', 'height', 'normal', 'ao', 'seamless', 'tile', 'to_svg', 'face_match']);
  assert.deepEqual(c.ops.filter(o => o.prep).map(o => o.name).sort(),
    ['blur', 'edges', 'levels', 'local_contrast', 'posterize', 'remove_bg', 'sharpen']);
  const rb = c.ops.find(o => o.name === 'remove_bg');
  assert.equal(rb.params.model.default, 'birefnet-general-lite');   // lite: ~20 s vs ~50 s (the 60 s web timeout)
  assert.equal(typeof rb.available.python, 'boolean');
  assert.deepEqual(Object.keys(rb.available.models), ['birefnet-general', 'birefnet-general-lite', 'isnet-general-use', 'u2net']);
  const trim = c.ops.find(o => o.name === 'trim');
  assert.deepEqual(trim.params.threshold, { type: 'integer', min: 0, max: 255, default: 10, doc: trim.params.threshold.doc });
  const svg = c.ops.find(o => o.name === 'to_svg');
  assert.deepEqual(Object.keys(svg.methods), ['mono', 'layers', 'vtracer']);
  assert.equal(svg.methods.mono.params.threshold.default, 128);
  assert.equal(svg.methods.vtracer.params.prep.type, 'array');
  assert.ok(svg.methods.vtracer.params.prep.ops.includes('remove_bg'));
  assert.equal(typeof svg.methods.vtracer.available, 'boolean');
  assert.ok(c.notes.some(n => n.includes('to_art')));
});

test('crop: pixel box, lineage, origin, label', async () => {
  const r = await ok('crop', { asset_id: 'icon', x: 10, y: 20, w: 100, h: 50, label: 'my crop', origin: { room_id: 'r1', agent: 'a', junk: 1 } });
  assert.deepEqual([r.meta.width, r.meta.height, r.meta.hasAlpha], [100, 50, true]);
  assert.deepEqual(r.body.params, { x: 10, y: 20, w: 100, h: 50 });
  assert.equal(r.post.label, 'my crop');
  assert.deepEqual(r.post.meta.origin, { kind: 'room', room_id: 'r1', agent: 'a' });
  assert.equal(r.post.filename, 'icon_crop.png');
  assert.equal((await op('crop', { asset_id: 'icon', x: 200, y: 0, w: 100, h: 10 })).status, 400);
  assert.equal((await op('crop', { asset_id: 'icon', x: 0, y: 0, w: 10 })).status, 400);
});

test('trim: cuts the white border, pads back; defaults echoed', async () => {
  const r = await ok('trim', { asset_id: 'icon' });
  assert.deepEqual(r.body.params, { threshold: 10, pad: 0 });
  // disc r=60 + arc to r=92 on the lower half → roughly 185 wide
  assert.ok(r.meta.width < 200 && r.meta.width > 170, `width ${r.meta.width}`);
  const p = await ok('trim', { asset_id: 'icon', pad: 5 });
  assert.equal(p.meta.width, r.meta.width + 10);
  assert.equal((await op('trim', { asset_id: 'icon', threshold: 300 })).status, 400);
});

test('flip: whole image and a region in place', async () => {
  const w = await ok('flip', { asset_id: 'tri', axis: 'h' });
  assert.deepEqual([w.meta.width, w.meta.height], [240, 240]);
  const px = async (buf, x, y) => [...(await sharp(buf).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  assert.equal((await px(w.post.bytes, 240 - 80, 120))[0], 220, 'red disc mirrored to the right');
  const g = await ok('flip', { asset_id: 'tri', axis: 'h', region: { x: 0, y: 0, w: 120, h: 240 } });
  assert.equal((await px(g.post.bytes, 40, 120))[0], 220, 'disc flipped within the left half');
  assert.equal((await px(g.post.bytes, 175, 120))[2], 200, 'blue box untouched');
  assert.equal((await op('flip', { asset_id: 'tri', axis: 'x' })).status, 400);
  assert.equal((await op('flip', { asset_id: 'tri', axis: 'h', region: { x: 200, y: 0, w: 100, h: 10 } })).status, 400);
});

test('rotate: right angles and arbitrary', async () => {
  const r = await ok('rotate', { asset_id: 'alpha', deg: 90 });
  assert.deepEqual([r.meta.width, r.meta.height], [100, 200]);
  assert.deepEqual(r.body.params, { deg: 90, background: 'transparent' });
  const a = await ok('rotate', { asset_id: 'alpha', deg: 30, background: '#ffffff' });
  assert.ok(a.meta.width > 200);
  assert.equal((await op('rotate', { asset_id: 'alpha', deg: 'ninety' })).status, 400);
});

test('resize: inside / contain / cover', async () => {
  assert.deepEqual([(await ok('resize', { asset_id: 'alpha', width: 100 })).meta.height], [50]);
  const c = await ok('resize', { asset_id: 'alpha', width: 64, height: 64, fit: 'contain' });
  assert.deepEqual([c.meta.width, c.meta.height], [64, 64]);
  assert.equal(c.body.params.background, 'transparent');
  const v = await ok('resize', { asset_id: 'alpha', width: 64, height: 64, fit: 'cover' });
  assert.deepEqual([v.meta.width, v.meta.height], [64, 64]);
  assert.equal((await op('resize', { asset_id: 'alpha' })).status, 400);
  assert.equal((await op('resize', { asset_id: 'alpha', width: 99999 })).status, 400);
});

test('pad: square and to a size, centred', async () => {
  const s = await ok('pad', { asset_id: 'alpha', square: true });
  assert.deepEqual([s.meta.width, s.meta.height], [200, 200]);
  const z = await ok('pad', { asset_id: 'alpha', width: 300, height: 120, background: '#ffffff' });
  assert.deepEqual([z.meta.width, z.meta.height], [300, 120]);
  assert.equal((await op('pad', { asset_id: 'alpha', width: 50 })).status, 400);
  assert.equal((await op('pad', { asset_id: 'alpha' })).status, 400);
  assert.equal((await op('pad', { asset_id: 'alpha', square: true, background: 'blue' })).status, 400);
});

test('threshold: two colours; alpha kept when meaningful', async () => {
  const t = await ok('threshold', { asset_id: 'tri', colors: { fg: '#ff0000' } });
  assert.deepEqual(t.body.params, { level: 128, colors: { fg: '#ff0000', bg: '#ffffff' } });
  const { data, info } = await sharp(t.post.bytes).raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  for (let i = 0; i < data.length; i += info.channels) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
  assert.deepEqual([...seen].sort(), ['255,0,0,255', '255,255,255,255']);
  const a = await ok('threshold', { asset_id: 'alpha' });
  const px = [...(await sharp(a.post.bytes).extract({ left: 150, top: 50, width: 1, height: 1 }).raw().toBuffer())];
  assert.equal(px[3], 0, 'transparent stays transparent');
  const d = [...(await sharp(a.post.bytes).extract({ left: 50, top: 50, width: 1, height: 1 }).raw().toBuffer())];
  assert.deepEqual(d, [0, 0, 0, 255]);
  assert.equal((await op('threshold', { asset_id: 'tri', level: -1 })).status, 400);
});

test('invert', async () => {
  const r = await ok('invert', { asset_id: 'icon' });
  const px = [...(await sharp(r.post.bytes).extract({ left: 128, top: 128, width: 1, height: 1 }).raw().toBuffer())];
  assert.equal(px[0], 255);
  assert.deepEqual(r.body.params, {});
  assert.equal((await op('invert', { asset_id: 'icon', foo: 1 })).status, 400);
});

// ── fill: magic wand + paint ──────────────────────────────────────────────────────────
async function rgbaAt(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
}
const DISC = { x: 0.3, y: 0.5 };        // (60,100): centre of the red disc in the ring
const RED = [220, 30, 30, 255], RED2 = [200, 30, 30, 255], BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];

test('fill: clear a disc (contiguous) → RGBA PNG; defaults echoed; catalogue', async () => {
  const r = await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear' });
  assert.deepEqual(r.body.params, { points: [DISC], mode: 'clear', tolerance: 32, contiguous: true, grow: 0, feather: 0 });
  assert.equal(r.meta.channels, 4);
  const a = await rgbaAt(r.post.bytes);
  assert.equal(a(60, 100)[3], 0, 'disc centre cleared');
  assert.equal(a(99, 100)[3], 0, 'disc edge cleared');
  assert.deepEqual(a(100, 100), WHITE, 'gap outside the disc kept');
  assert.deepEqual(a(113, 100), BLACK, 'ring kept');
  assert.deepEqual(a(160, 100), RED2, 'the other disc is not connected');
  assert.ok(r.post.meta.selected > 4900 && r.post.meta.selected < 5100, `selected ${r.post.meta.selected}`);
  const c = (await (await fetch(`${TOOL_URL}/ops`)).json()).ops.find(o => o.name === 'fill');
  assert.equal(c.params.points.type, 'array');
  assert.match(c.purpose, /four corners/);
});

test('fill: contiguous false hits disjoint regions; tolerance is an inclusive max channel difference', async () => {
  const t19 = await rgbaAt((await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear', contiguous: false, tolerance: 19 })).post.bytes);
  assert.equal(t19(60, 100)[3], 0);
  assert.deepEqual(t19(160, 100), RED2, '20 off > tolerance 19');
  const t20 = await rgbaAt((await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear', contiguous: false, tolerance: 20 })).post.bytes);
  assert.equal(t20(60, 100)[3], 0);
  assert.equal(t20(160, 100)[3], 0, 'the disjoint second disc is hit at tolerance 20');
  assert.deepEqual(t20(113, 100), BLACK);
  assert.deepEqual(t20(5, 5), WHITE);
  const c20 = await rgbaAt((await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear', tolerance: 20 })).post.bytes);
  assert.deepEqual(c20(160, 100), RED2, 'contiguous: not reached across the ring');
});

test('fill: paint a colour; several seeds union', async () => {
  const r = await ok('fill', { asset_id: 'paint', points: [{ x: 0.566, y: 0.5 }, { x: 0.8, y: 0.5 }], mode: 'fill', color: '#00ff00' });
  const a = await rgbaAt(r.post.bytes);
  assert.deepEqual(a(113, 100), [0, 255, 0, 255], 'ring painted');
  assert.deepEqual(a(60, 47), [0, 255, 0, 255], 'the whole ring (top)');
  assert.deepEqual(a(160, 100), [0, 255, 0, 255], 'second seed: the other disc');
  assert.deepEqual(a(60, 100), RED, 'the disc is untouched');
  assert.deepEqual(a(5, 5), WHITE);
});

test('fill: sample paints the colour picked at color_from', async () => {
  const r = await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'sample', color_from: { x: 0, y: 0 } });
  assert.equal(r.post.meta.color, '#ffffffff');
  const a = await rgbaAt(r.post.bytes);
  assert.deepEqual(a(60, 100), WHITE);
  assert.deepEqual(a(113, 100), BLACK);
});

test('fill: grow dilates the selection, feather fades it out', async () => {
  const g = await rgbaAt((await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear', grow: 3 })).post.bytes);
  assert.equal(g(102, 100)[3], 0, '3 px out: cleared');
  assert.equal(g(103, 100)[3], 255, '4 px out: kept');
  const f = await rgbaAt((await ok('fill', { asset_id: 'paint', points: [DISC], mode: 'clear', feather: 4 })).post.bytes);
  assert.equal(f(99, 100)[3], 0);
  assert.equal(f(101, 100)[3], 128, '2 px into a 4 px feather: half');
  assert.equal(f(104, 100)[3], 255);
});

test('fill: clear the background = clear seeded at the four corners', async () => {
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  const a = await rgbaAt((await ok('fill', { asset_id: 'paint', points: corners, mode: 'clear' })).post.bytes);
  for (const [x, y] of [[0, 0], [199, 0], [0, 199], [199, 199], [1, 100], [130, 100]]) assert.equal(a(x, y)[3], 0, `${x},${y} cleared`);
  assert.deepEqual(a(105, 100), WHITE, 'white enclosed by the ring is not background');
  assert.deepEqual(a(113, 100), BLACK);
  assert.deepEqual(a(160, 100), RED2);
});

test('fill: 400 on bad params', async () => {
  const pt = [{ x: 0, y: 0 }];
  for (const extra of [{}, { points: [] }, { points: [{ x: 1.5, y: 0 }] }, { points: [{ x: 0 }] }, { points: [[0, 0]] },
    { points: Array(65).fill({ x: 0, y: 0 }) }, { points: pt, mode: 'erase' }, { points: pt, mode: 'fill' },
    { points: pt, mode: 'sample' }, { points: pt, color: '#000000' }, { points: pt, color_from: { x: 0, y: 0 } },
    { points: pt, tolerance: 300 }, { points: pt, grow: -1 }]) {
    assert.equal((await op('fill', { asset_id: 'paint', mode: 'clear', ...extra })).status, 400, JSON.stringify(extra));
  }
  assert.equal((await op('fill', { asset_id: 'paint', points: pt })).status, 400, 'mode is required');
});

test('errors: unknown asset 404, non-image 400, unknown op 404, missing asset_id 400', async () => {
  assert.equal((await op('invert', { asset_id: 'nope' })).status, 404);
  const w = await op('invert', { asset_id: 'wav' });
  assert.equal(w.status, 400);
  assert.match(w.body.error, /image/);
  assert.equal((await op('magic', { asset_id: 'icon' })).status, 404);
  assert.equal((await op('invert', {})).status, 400);
});

test('to_svg mono: fill with currentColor, defaults echoed', async () => {
  const r = await ok('to_svg', { asset_id: 'icon' });
  assert.equal(r.body.params.method, 'mono');
  assert.equal(r.body.params.threshold, 128);
  assert.equal(r.body.params.traceSize, 512);
  assert.equal(r.body.params.currentColor, true);
  assert.match(r.svg, /<path[^>]*d="M/);
  assert.match(r.svg, /fill="currentColor"/);
  assert.equal(r.post.meta.method, 'mono');
  assert.equal(r.post.filename, 'icon_svg-mono.svg');
});

test('to_svg mono: outline style = fill none + stroke', async () => {
  const r = await ok('to_svg', { asset_id: 'icon', style: 'outline', strokeWidth: 3 });
  assert.match(r.svg, /fill="none"/);
  assert.match(r.svg, /stroke="currentColor"/);
  assert.match(r.svg, /stroke-width="3"/);
});

test('to_svg mono: explicit colour keeps it; alpha channel auto', async () => {
  const r = await ok('to_svg', { asset_id: 'icon', color: '#112233' });
  assert.equal(r.body.params.currentColor, false);
  assert.match(r.svg, /fill="#123"/);   // SVGO shortens colours
  const a = await ok('to_svg', { asset_id: 'alpha' });
  assert.equal(a.post.meta.channel, 'alpha');
  assert.equal((await op('to_svg', { asset_id: 'icon', threshold: 999 })).status, 400);
  assert.equal((await op('to_svg', { asset_id: 'icon', colors: 4 })).status, 400, 'layers-only param rejected for mono');
  assert.equal((await op('to_svg', { asset_id: 'icon', method: 'magic' })).status, 400);
});

test('to_svg layers: ≥2 coloured fills', async () => {
  const r = await ok('to_svg', { asset_id: 'tri', method: 'layers', colors: 3 });
  assert.equal(r.body.params.dropBackground, true);
  assert.equal(r.body.params.currentColor, false);
  const fills = new Set([...r.svg.matchAll(/fill="(#[0-9a-f]+)"/gi)].map(m => m[1]));
  assert.ok(fills.size >= 2, `fills: ${[...fills]}`);
  assert.equal(r.post.meta.background, '#ffffff');
  const o = await ok('to_svg', { asset_id: 'tri', method: 'layers', colors: 3, style: 'outline', dropBackground: false });
  assert.match(o.svg, /stroke="#/);
});

test('to_svg vtracer: SVG when installed, else 503', async () => {
  const py = process.env.IMAGE_OPS_PYTHON || 'python3';
  const installed = await access(py).then(() => true, () => false);
  if (!installed) {
    const r = await op('to_svg', { asset_id: 'tri', method: 'vtracer' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'vtracer not installed');
    assert.ok(r.body.hint);
    return;
  }
  const r = await ok('to_svg', { asset_id: 'tri', method: 'vtracer' });
  assert.equal(r.body.params.filter_speckle, 4);
  assert.equal(r.body.params.path_precision, 3);
  assert.match(r.svg, /<path/);
  const b = await ok('to_svg', { asset_id: 'icon', method: 'vtracer', colormode: 'binary', mode: 'polygon' });
  assert.match(b.svg, /<path/);
});

// ── phase 2: prep ops ─────────────────────────────────────────────────────────────────
const pixelsOf = async (buf) => sharp(buf).raw().toBuffer({ resolveWithObject: true });
// greyscale PNGs decode to 3 bands in sharp — take band 0 → one byte per pixel
const greyOf = async (buf) => sharp(buf).extractChannel(0).raw().toBuffer();
async function greyStats(buf) { const s = await sharp(buf).stats(); return s.channels[0]; }

test('levels: auto stretches a low-contrast image; manual points; 400s', async () => {
  const r = await ok('levels', { asset_id: 'faint' });
  assert.deepEqual(r.body.params, { gamma: 1, auto: true });
  assert.ok(r.post.meta.black >= 200 && r.post.meta.white <= 230, JSON.stringify(r.post.meta));
  const st = await greyStats(r.post.bytes);
  assert.deepEqual([st.min, st.max], [0, 255]);
  assert.deepEqual([r.meta.width, r.meta.height], [256, 256]);
  const m = await ok('levels', { asset_id: 'hramp', black: 64, white: 192, gamma: 1 });
  assert.deepEqual(m.body.params, { black: 64, white: 192, gamma: 1, auto: false });
  const { data, info } = await pixelsOf(m.post.bytes);
  assert.equal(data[16 * info.channels], 0, 'x=16 (32) → below black');
  assert.equal(data[127 * info.channels], 255, 'x=127 (254) → above white');
  assert.equal((await op('levels', { asset_id: 'faint', auto: true, black: 5 })).status, 400);
  assert.equal((await op('levels', { asset_id: 'faint', black: 100, white: 100 })).status, 400);
  assert.equal((await op('levels', { asset_id: 'faint', gamma: 0 })).status, 400);
});

// mean |x − blur(x, 4)| — local detail
async function detail(buf) {
  const a = await greyOf(await sharp(buf).greyscale().png().toBuffer()), b = await greyOf(await sharp(buf).greyscale().blur(4).png().toBuffer());
  let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length;
}

test('local_contrast: CLAHE raises the local contrast of faint shaded lines; alpha kept', async () => {
  const r = await ok('local_contrast', { asset_id: 'shaded' });
  assert.deepEqual(r.body.params, { strength: 2, radius: 32 });
  const before = await detail(readFileSync(assets.get('shaded').file)), after = await detail(r.post.bytes);
  assert.ok(after > before * 1.2, `detail ${before.toFixed(2)} → ${after.toFixed(2)}`);
  const off = await ok('local_contrast', { asset_id: 'shaded', strength: 0 });
  assert.ok(Math.abs(await detail(off.post.bytes) - before) < 0.05, 'strength 0 = unchanged');
  const a = await ok('local_contrast', { asset_id: 'alpha', strength: 4, radius: 16 });
  const px = [...(await sharp(a.post.bytes).extract({ left: 150, top: 50, width: 1, height: 1 }).raw().toBuffer())];
  assert.equal(px[3], 0, 'transparent stays transparent');
  assert.equal((await op('local_contrast', { asset_id: 'faint', strength: 6 })).status, 400);
});

test('sharpen / blur / posterize', async () => {
  const s = await ok('sharpen', { asset_id: 'faint' });
  assert.deepEqual(s.body.params, { sigma: 1.5, m1: 1, m2: 2, x1: 2, y2: 10, y3: 20 });
  assert.deepEqual([s.meta.width, s.meta.height], [256, 256]);
  const b = await ok('blur', { asset_id: 'icon', sigma: 3 });
  assert.deepEqual(b.body.params, { sigma: 3 });
  const bs = await greyStats(b.post.bytes);
  assert.ok(bs.stdev < (await greyStats(assets.get('icon').file)).stdev);
  assert.equal((await op('blur', { asset_id: 'icon', sigma: 0 })).status, 400);
  const p = await ok('posterize', { asset_id: 'hramp', levels: 2 });
  const { data } = await pixelsOf(p.post.bytes);
  assert.deepEqual([...new Set(data.filter((_, i) => i % 4 === 0))].sort((x, y) => x - y), [0, 255]);
  assert.deepEqual((await ok('posterize', { asset_id: 'hramp' })).body.params, { levels: 6 });
  assert.equal((await op('posterize', { asset_id: 'hramp', levels: 1 })).status, 400);
});

test('edges: dark outlines on white, greyscale; threshold binarises', async () => {
  const r = await ok('edges', { asset_id: 'icon' });
  assert.deepEqual(r.body.params, { method: 'sobel', strength: 2, invert: true });
  assert.equal(r.meta.channels, 1, 'greyscale PNG');
  const data = await greyOf(r.post.bytes);
  const at = (x, y) => data[y * 256 + x];
  assert.equal(at(5, 5), 255, 'flat background → white');
  assert.equal(at(128, 128), 255, 'flat disc interior → white');
  assert.ok(at(128 + 60, 128) < 64 || at(128 + 59, 128) < 64, 'disc rim → dark line');
  const t = await ok('edges', { asset_id: 'faint', strength: 8, threshold: 60 });
  const td = await greyOf(t.post.bytes);
  assert.deepEqual([...new Set(td)].sort((x, y) => x - y), [0, 255]);
  assert.ok(td.filter(v => v === 0).length > 500, 'the faint ring + bar are picked up');
  assert.equal((await op('edges', { asset_id: 'icon', method: 'canny' })).status, 400);
});

// ── phase 2: game textures ────────────────────────────────────────────────────────────
test('height: greyscale, auto contrast to full range, invert', async () => {
  const r = await ok('height', { asset_id: 'noisy' });
  assert.deepEqual(r.body.params, { channel: 'luminance', invert: false, blur: 1, contrast: 'auto', wrap: false });
  assert.equal(r.meta.channels, 1);
  const st = await greyStats(r.post.bytes);
  assert.deepEqual([st.min, st.max], [0, 255]);
  const i = await ok('height', { asset_id: 'hramp', invert: true, blur: 0, contrast: 'none' });
  const data = await greyOf(i.post.bytes);
  assert.ok(data[0] > 250 && data[127] < 5, `inverted ramp ${data[0]}..${data[127]}`);
  assert.equal((await op('height', { asset_id: 'noisy', channel: 'x' })).status, 400);
});

test('normal: flat → (128,128,255); OpenGL +Y up, flip_green = DirectX', async () => {
  const f = await ok('normal', { asset_id: 'flat' });
  assert.deepEqual(f.body.params, { strength: 2, source: 'image', flip_green: false, wrap: false });
  const { data } = await pixelsOf(f.post.bytes);
  for (let i = 0; i < data.length; i += 4) assert.deepEqual([data[i], data[i + 1], data[i + 2]], [128, 128, 255]);
  const mid = async (id, extra) => {
    const r = await ok('normal', { asset_id: id, source: 'height', ...extra });
    const p = await pixelsOf(r.post.bytes);
    const o = ((p.info.height >> 1) * p.info.width + (p.info.width >> 1)) * p.info.channels;
    return [...p.data.subarray(o, o + 3)];
  };
  const h = await mid('hramp');                     // rises to the right → faces left → red < 128
  assert.ok(h[0] < 120 && Math.abs(h[1] - 128) <= 1, `hramp ${h}`);
  const v = await mid('vramp');                     // rises downward → faces up the image → green > 128 (OpenGL)
  assert.ok(v[1] > 136 && Math.abs(v[0] - 128) <= 1, `vramp ${v}`);
  const d = await mid('vramp', { flip_green: true });
  assert.ok(d[1] < 120, `DirectX green ${d}`);
  assert.equal((await op('normal', { asset_id: 'flat', strength: 0 })).status, 400);
});

test('ao: flat = white, bumps darken', async () => {
  const f = await ok('ao', { asset_id: 'flat' });
  assert.deepEqual(f.body.params, { radius: 8, strength: 1, source: 'image', wrap: false });
  assert.equal(f.meta.channels, 1);
  assert.equal((await greyStats(f.post.bytes)).min, 255);
  const n = await ok('ao', { asset_id: 'noisy', radius: 4, strength: 2 });
  const st = await greyStats(n.post.bytes);
  assert.ok(st.mean < 250 && st.min < 128, `ao mean ${st.mean} min ${st.min}`);
});

// mean |a − b| between two 1-px lines of an RGB(A) image
async function seam(buf, axis) {
  const { data, info } = await pixelsOf(buf);
  const { width: W, height: H, channels: C } = info;
  let sum = 0, n = 0;
  const len = axis === 'lr' ? H : W;
  for (let k = 0; k < len; k++) {
    const a = axis === 'lr' ? (k * W) * C : k * C, b = axis === 'lr' ? (k * W + W - 1) * C : ((H - 1) * W + k) * C;
    for (let c = 0; c < 3; c++) { sum += Math.abs(data[a + c] - data[b + c]); n++; }
  }
  return sum / n;
}

test('seamless: the tile edges meet; preview = a 2×2 tile image parented to the tile', async () => {
  const src = readFileSync(assets.get('wave').file);
  const r = await ok('seamless', { asset_id: 'wave' });
  assert.deepEqual(r.body.params, { method: 'offset-blend', blend: 64, preview: false });
  assert.deepEqual([r.meta.width, r.meta.height], [200, 160]);
  assert.equal(r.post.meta.blend_px, 64);
  for (const axis of ['lr', 'tb']) {
    const before = await seam(src, axis), after = await seam(r.post.bytes, axis);
    assert.ok(after < 3 && after < before / 5, `${axis}: seam ${before.toFixed(1)} → ${after.toFixed(1)}`);
  }
  assert.equal(r.body.preview, undefined);
  const p = await op('seamless', { asset_id: 'wave', blend: 0.25, preview: true });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const [tilePost, prevPost] = posted.slice(-2);
  assert.equal(tilePost.parent_id, 'wave');
  assert.equal(tilePost.meta.blend_px, 40);
  assert.equal(p.body.preview.id, `out${posted.length}`);
  assert.equal(prevPost.parent_id, p.body.asset.id, 'preview is a child of the tile');
  assert.deepEqual(prevPost.derived_op, { tool: 'image-ops', op: 'tile', params: { x: 2, y: 2 } });
  const pm = await sharp(prevPost.bytes).metadata();
  assert.deepEqual([pm.width, pm.height], [400, 320]);
  assert.equal((await op('seamless', { asset_id: 'wave', method: 'mirror' })).status, 400);
});

test('tile: x × y grid; bounded', async () => {
  const t = await ok('tile', { asset_id: 'wave', x: 3, y: 1 });
  assert.deepEqual([t.meta.width, t.meta.height], [600, 160]);
  assert.deepEqual((await ok('tile', { asset_id: 'flat' })).body.params, { x: 2, y: 2 });
  assert.equal((await op('tile', { asset_id: 'wave', x: 9 })).status, 400);
});

// ── phase 2: remove_bg + to_svg prep ──────────────────────────────────────────────────
const PY = process.env.IMAGE_OPS_PYTHON || 'python3';
const MODEL_DIR = process.env.IMAGE_OPS_MODEL_DIR || (process.env.HOME || '.') + '/asset-management/image-ops-models';
const hasRembg = (() => { try { execFileSync(PY, ['-c', 'import rembg']); return true; } catch { return false; } })();
const LITE = 'birefnet-general-lite';
const hasLite = existsSync(path.join(MODEL_DIR, 'models', LITE, `${LITE}.onnx`));

test('remove_bg: 400 on bad params; 503 + hint when rembg/model missing', async () => {
  assert.equal((await op('remove_bg', { asset_id: 'icon', model: 'sam' })).status, 400);
  assert.equal((await op('remove_bg', { asset_id: 'icon', output: 'png' })).status, 400);
  if (hasRembg && hasLite) return;
  const r = await op('remove_bg', { asset_id: 'icon', model: LITE });
  assert.equal(r.status, 503);
  assert.match(r.body.error, hasRembg ? /not downloaded/ : /rembg not installed/);
  assert.match(r.body.hint, /--fetch/);
});

test('remove_bg: black disc on white → transparent corners, opaque centre', { skip: !(hasRembg && hasLite) && 'rembg or model not installed' }, async () => {
  const r = await ok('remove_bg', { asset_id: 'icon', model: LITE });
  assert.deepEqual(r.body.params, { model: LITE, output: 'rgba', post_process_mask: true, alpha_matting: false,
    alpha_matting_foreground_threshold: 240, alpha_matting_background_threshold: 10, alpha_matting_erode_size: 10, feather: 0, max_side: 1536 });
  assert.equal(r.post.meta.model, LITE);
  const { data, info } = await pixelsOf(r.post.bytes);
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  for (const [x, y] of [[3, 3], [252, 3], [3, 252], [252, 252]]) assert.ok(alphaAt(x, y) < 16, `corner ${x},${y} alpha ${alphaAt(x, y)}`);
  assert.ok(alphaAt(128, 128) > 240, `centre alpha ${alphaAt(128, 128)}`);
  const m = await ok('remove_bg', { asset_id: 'icon', model: LITE, output: 'mask' });
  assert.equal(m.meta.channels, 1);
});

test('to_svg prep: steps run before the trace and are recorded with defaults', async () => {
  const prep = [{ op: 'levels' }, { op: 'local_contrast', strength: 3 }, { op: 'sharpen' }];
  const r = await ok('to_svg', { asset_id: 'faint', prep, threshold: 160 });
  assert.deepEqual(r.body.params.prep, [
    { op: 'levels', gamma: 1, auto: true },
    { op: 'local_contrast', strength: 3, radius: 32 },
    { op: 'sharpen', sigma: 1.5, m1: 1, m2: 2, x1: 2, y2: 10, y3: 20 },
  ]);
  assert.match(r.svg, /<path[^>]*d="M/);
  // without prep the same faint art has nothing darker than 160 → nothing traced
  assert.equal((await op('to_svg', { asset_id: 'faint', threshold: 160 })).status, 422);
  const e = await ok('to_svg', { asset_id: 'faint', method: 'layers', colors: 2, prep: [{ op: 'edges', strength: 8 }] });
  assert.deepEqual(e.body.params.prep, [{ op: 'edges', method: 'sobel', strength: 8, invert: true }]);
  assert.equal((await op('to_svg', { asset_id: 'faint', prep: [{ op: 'crop', x: 0, y: 0, w: 1, h: 1 }] })).status, 400);
  const bad = await op('to_svg', { asset_id: 'faint', prep: [{ op: 'blur', sigma: 0 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /prep\[0\]\.sigma/);
  assert.equal((await op('to_svg', { asset_id: 'faint', prep: { op: 'blur' } })).status, 400);
  if (hasRembg && hasLite) {
    const b = await ok('to_svg', { asset_id: 'icon', prep: [{ op: 'remove_bg', model: LITE }] });
    assert.equal(b.body.params.prep[0].model, LITE);
    assert.equal(b.post.meta.channel, 'alpha', 'traced from the cut-out alpha');
  }
});

test('staging files are cleaned up after registration', () => {
  const work = process.env.IMAGE_OPS_WORK;
  const left = existsSync(work) ? execFileSync('ls', ['-A', work]).toString().trim() : '';
  assert.equal(left, '');
});

// ── face_match: analysis only (scores, no new image) ──────────────────────────────────
const hasFaceModels = ['det_10g.onnx', 'w600k_r50.onnx'].every(f => existsSync(path.join(MODEL_DIR, 'insightface', 'buffalo_l', f)));
const hasOrt = (() => { try { execFileSync(PY, ['-c', 'import onnxruntime, numpy, PIL']); return true; } catch { return false; } })();

test('face_match is OFF unless IMAGE_OPS_FACE_MATCH=1: 503 with the reason, no model run', async () => {
  const was = process.env.IMAGE_OPS_FACE_MATCH;
  delete process.env.IMAGE_OPS_FACE_MATCH;
  try {
    const r = await op('face_match', { asset_id: 'icon', candidates: ['tri'] });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /memory cap/);
  } finally {
    if (was !== undefined) process.env.IMAGE_OPS_FACE_MATCH = was;
  }
});

test('face_match: 400 on bad params, never makes an image; 503 + hint without the models; 422 when the source has no face', async () => {
  process.env.IMAGE_OPS_FACE_MATCH = '1';
  assert.equal((await op('face_match', { asset_id: 'icon' })).status, 400);                                  // candidates required
  assert.equal((await op('face_match', { asset_id: 'icon', candidates: [] })).status, 400);
  assert.equal((await op('face_match', { asset_id: 'icon', candidates: Array.from({ length: 17 }, (_, i) => `c${i}`) })).status, 400);
  assert.equal((await op('face_match', { asset_id: 'icon', candidates: ['tri'], det_size: 100 })).status, 400);
  assert.equal((await op('face_match', { asset_id: 'icon', candidates: ['tri'], colour: 'x' })).status, 400);
  const before = posted.length;
  const r = await op('face_match', { asset_id: 'icon', candidates: ['tri'] });
  assert.equal(posted.length, before, 'analysis only: nothing registered');
  if (!(hasOrt && hasFaceModels)) {
    assert.equal(r.status, 503);
    assert.match(r.body.hint, /--fetch|install/);
  } else {
    assert.equal(r.status, 422);
    assert.match(r.body.error, /no face/);
    assert.equal((await op('face_match', { asset_id: 'wav', candidates: ['tri'] })).status, 400);             // not an image
  }
});

test('catalogue: face_match is an analysis op with the licence stated', async () => {
  const c = await (await fetch(`${TOOL_URL}/ops`)).json();
  const f = c.ops.find(o => o.name === 'face_match');
  assert.equal(f.analysis, true);
  assert.match(f.purpose, /NON-COMMERCIAL/);
  assert.equal(typeof f.available.models.buffalo_l, 'boolean');
  assert.equal(f.params.det_size.default, 640);
});

test('face_match: scores the same person above a different one, ranks best-first, records meta.identity', { skip: !(hasOrt && hasFaceModels && FACE_FIXTURES) && 'needs the models and IMAGE_OPS_FACE_FIXTURES (source.png, same.png, other.png)' }, async () => {
  const r = await op('face_match', { asset_id: 'face-source', candidates: ['face-other', 'face-same', 'icon'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.results.map(c => [c.id, c]));
  assert.ok(by['face-same'].score > by['face-other'].score + 0.2, JSON.stringify(by));
  assert.equal(by['face-same'].verdict === 'same person' || by['face-same'].verdict === 'strong match', true);
  assert.equal(by.icon.score, null);
  assert.equal(by.icon.verdict, 'no face');
  assert.deepEqual(r.body.ranking, ['face-same', 'face-other']);
  assert.equal(r.body.best, 'face-same');
  const rec = patched.filter(x => x.body.meta?.identity);
  assert.equal(rec.length, 3);
  const same = rec.find(x => x.id === 'face-same').body.meta.identity;
  assert.deepEqual([same.source_id, same.model], ['face-source', 'buffalo_l']);
  assert.equal(typeof same.at, 'string');
  const n = patched.length;
  await op('face_match', { asset_id: 'face-source', candidates: ['face-same'], record: false });
  assert.equal(patched.length, n, 'record:false writes nothing');
});
