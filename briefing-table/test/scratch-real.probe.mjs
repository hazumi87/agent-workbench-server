/* THE REAL SCRATCHPAD, WITH REAL PICTURES [scratch real]  node test/scratch-real.probe.mjs   (the design system ask, 2026-10-07)
 * Every other Scratchpad probe stubs the engine's routes. This one boots a REAL scratch engine (dead broker, temp table, never a live pane) with a
 * stub agent-share behind it holding generated PICTURES (gradient scenes), so the engine's own batch answers: counts, seen, thumbnails, summary notes,
 * lineId, the item verbs. It asserts the five things that need the real thing and, with SHOTS_DIR, saves PC + phone screenshots for review:
 *   - the "new" dot sits on a real thumbnail (not a placeholder), and counts say N new of M
 *   - opening an item drops the count (POST scratchpad/seen) and the dot goes with it
 *   - the ⋯ menu (Rename / Move to / Remove) acts on the real item
 *   - a note card shows its author and tags; the opened note too */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(428);
const DEAD = P(429);
const SHARE = P(430);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-scratch-real-token';
const SHOTS = process.env.SHOTS_DIR || '';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
for (const [p, n] of [[PORT, 'engine'], [DEAD, 'dead broker'], [SHARE, 'stub share']]) { await assertFree(p, `scratch-real.probe.mjs (${n})`); }

/* ---- the pictures: six gradient "scenes" (a sky, a field, a sunset...), real PNGs, not flat swatches ---- */
const SCENES = [
  ['sunset.png', ['#ff7e5f', '#feb47b', '#6a3093']],
  ['lake.png', ['#2193b0', '#6dd5ed', '#0b3d5c']],
  ['forest.png', ['#134e5e', '#71b280', '#0b2a1f']],
  ['desert.png', ['#f6d365', '#fda085', '#7a3e1d']],
  ['auriga.png', ['#00c9ff', '#92fe9d', '#3a1c71']],
  ['night.png', ['#0f2027', '#203a43', '#2c5364']],
];
const picture = async (stops, w = 960, h = 640) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.35}" r="${h * 0.16}" fill="rgba(255,255,255,.55)"/><path d="M0 ${h * 0.8} Q ${w * 0.3} ${h * 0.55} ${w * 0.55} ${h * 0.78} T ${w} ${h * 0.7} V ${h} H0 Z" fill="rgba(0,0,0,.35)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};
const files = new Map();
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' && u.pathname === '/api/list') {
      const d = u.searchParams.get('dir') ?? '';
      const entries = [...files.keys()].filter((k) => k.slice(0, k.lastIndexOf('/')) === d).map((k) => ({ name: k.slice(k.lastIndexOf('/') + 1), path: k, type: 'file', size: files.get(k).bytes.length, mtime: files.get(k).mtime }));
      return json(entries.length ? 200 : 404, entries.length ? { entries } : { error: 'no such dir' });
    }
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      const d = u.searchParams.get('dir') ?? '';
      const body = Buffer.concat(chunks);
      const text = body.toString('latin1');
      const at = text.indexOf('filename="') + 'filename="'.length;
      let name = text.slice(at, text.indexOf('"', at));
      if (files.has(`${d}/${name}`)) { name = `1-${name}`; }
      const start = body.indexOf(Buffer.from([13, 10, 13, 10])) + 4;
      const end = body.lastIndexOf(Buffer.from([13, 10, 45, 45]));
      files.set(`${d}/${name}`, { bytes: body.subarray(start, end), mtime: Date.now() / 1000 });
      return json(200, { ok: true, saved: [`${d}/${name}`] });
    }
    if (req.method === 'POST' && u.pathname === '/api/move') {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const f = files.get(b.from);
      if (!f) { return json(404, { error: 'from is not a file' }); }
      const name = b.from.slice(b.from.lastIndexOf('/') + 1);
      let dest = `${b.to_dir}/${name}`;
      if (files.has(dest)) { dest = `${b.to_dir}/1-${name}`; }
      files.delete(b.from);
      files.set(dest, f);
      return json(200, { ok: true, path: dest });
    }
    if (u.pathname.startsWith('/raw/')) {
      const ref = decodeURIComponent(u.pathname.slice(5));
      const f = files.get(ref);
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(f.bytes.length), 'last-modified': new Date(f.mtime * 1000).toUTCString() });
      return res.end(req.method === 'HEAD' ? undefined : f.bytes);
    }
    json(404, { error: 'not here' });
  });
});
await new Promise((r) => stub.listen(SHARE, '127.0.0.1', () => r()));

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-scratch-real-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Studio', projectDir: '/srv/x/studio', vendor: 'claude-code', agent: 'studio', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode', HARBOR_WB_AGENT_SHARE_URL: `http://127.0.0.1:${SHARE}` }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const seeded = (await seed({ rooms: [{ name: 'Studio', seats: [{ handle: 'studio', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'helper', recipe_id: 'rec-a' }] }] })).rooms[0];
  const R = seeded.id;
  const cookie = await windowCookie(BASE, TOKEN);
  const asPerson = async (path, method = 'GET', body, headers = {}) => {
    const init = { method, headers: { cookie, ...headers } };
    if (body !== undefined) { init.body = Buffer.isBuffer(body) ? body : JSON.stringify(body); if (!Buffer.isBuffer(body)) { init.headers['content-type'] = 'application/json'; } }
    const res = await fetch(BASE + path, init);
    let b = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };
  const folder = (await asPerson(`/api/rooms/${R}/assets`)).body.folder;
  const put = async (name, stops, ageSec) => { files.set(`${folder}/${name}`, { bytes: await picture(stops), mtime: Date.now() / 1000 - ageSec }); };
  /* BEFORE the baseline: three older pictures and one old note (everything before the first read is seen) */
  for (const [n, st] of SCENES.slice(0, 3)) { await put(n, st, 3600); }
  const oldNote = await asPerson(`/api/rooms/${R}/notes`, 'POST', { text: 'Brand colours: the sunset orange and the lake blue, nothing else.' });
  ok(oldNote.status === 200, 'an old note exists before the baseline', oldNote.status);
  const c0 = await asPerson(`/api/rooms/${R}/scratchpad/counts`);
  ok(c0.status === 200 && c0.body.assets.new === 0 && c0.body.assets.total === 3 && c0.body.notes.new === 0, 'baseline: 3 pictures, 1 note, nothing new yet', c0.body);
  await sleep(1200);
  /* AFTER it, from "someone else" (dropped on the share by an agent; a note posted with the bearer): new */
  for (const [n, st] of SCENES.slice(3)) { await put(n, st, -2); }
  const someone = await runTsx([join('test', 'scratch-real.seed.ts'), JSON.stringify({ room: R, by: 'u-zahkutya', handle: 'zahkutya', notes: ['Hero section: the lake picture full-bleed, the headline in white over the lower third. Keep the call to action to one button.', 'Contact page: name, email, one message box. No phone number field.'] })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  ok(someone.code === 0, 'two notes arrive from another person (written through the store)', someone.err.slice(-200));
  await sleep(600);
  const c1 = await asPerson(`/api/rooms/${R}/scratchpad/counts`);
  ok(c1.body.assets.new === 3 && c1.body.assets.total === 6 && c1.body.notes.new === 2 && c1.body.notes.total === 3, 'real counts: 3 of 6 pictures new, 2 of 3 notes new', c1.body);

  browser = await chromium.launch({ headless: true });
  const errs = [];
  const mkCtx = async (w, h, touch) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    return { ctx, pg };
  };
  const shot = async (pg, name) => { if (SHOTS) { await pg.screenshot({ path: join(SHOTS, name) }); } };
  /* a workgroup to move things to (Move to… lists the family's other rooms) */
  const helperSeat = seeded.seats.helper;
  const wg = await asPerson(`/api/rooms/${R}/workgroups`, 'POST', { name: 'Shop', alias: 'shop', move: [helperSeat], lead: { move: helperSeat } });
  const SHOP = wg.body?.room?.id ?? wg.body?.workgroup?.id ?? wg.body?.id;
  ok(!!SHOP, 'a workgroup exists to move into', wg.status);
  const counts = async () => (await asPerson(`/api/rooms/${R}/scratchpad/counts`)).body;
  const names = async (room = R) => ((await asPerson(`/api/rooms/${room}/assets`)).body?.assets ?? []).map((a) => a.name);
  let seq = 0;
  /* new things from someone else, each flow: two pictures on the share, one note written as another person */
  const freshen = async (tag) => {
    seq += 1;
    await sleep(1100);
    await put(`${tag}-one.png`, SCENES[seq % SCENES.length][1], -2);
    await put(`${tag}-two.png`, SCENES[(seq + 2) % SCENES.length][1], -2);
    await runTsx([join('test', 'scratch-real.seed.ts'), JSON.stringify({ room: R, by: 'u-zahkutya', handle: 'zahkutya', notes: [`A note for the ${tag} pass: the footer carries the address and the opening hours, nothing else.`] })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    await sleep(500);
  };
  const flow = async (dev, verbs) => {
    const phone = dev === 'phone';
    const { ctx, pg } = await mkCtx(phone ? 390 : 1400, phone ? 780 : 900, phone);
    await freshen(dev);
    const up = await asPerson(`/api/rooms/${R}/assets`, 'POST', await picture(SCENES[1][1], 640, 480), { 'x-filename': `mine-${dev}.png`, 'content-type': 'image/png' });
    ok(up.status === 200, `${dev}: a picture uploaded through the room (the engine records who)`, up.status);
    const c0 = await counts();
    ok(c0.assets.new >= 2 && c0.notes.new >= 1, `${dev}: the engine counts what arrived as new`, c0);
    await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const openAssets = async () => {
      if (phone) { await pg.click('#phAgents'); await sleep(300); await pg.click('.ph-padrow >> nth=0'); } else { await pg.click('.pad-line >> nth=0'); }
      await pg.waitForSelector('#preview .sp-tile', { timeout: 6000 }).catch(() => {});
      await sleep(900);
    };
    if (!phone) { await shot(pg, `${dev}-1-cell.png`); }
    await openAssets();
    const L = await pg.evaluate(() => {
      const tiles = [...document.querySelectorAll('#preview .sp-tile')];
      const dotted = tiles.filter((t) => t.querySelector('.sp-dot'));
      return { tiles: tiles.length, dotted: dotted.length, thumbs: dotted.map((t) => { const im = t.querySelector('.sp-th img'); return { src: im?.getAttribute('src') ?? null, w: im?.naturalWidth ?? 0 }; }), headNew: [...document.querySelectorAll('#preview .sp-gh')].map((h) => h.textContent) };
    });
    ok(L.dotted === c0.assets.new && L.dotted >= 2 && L.thumbs.every((t) => t.w > 0 && /\/assets\/thumb\//.test(t.src ?? '')), `${dev}: the new dot sits on a REAL thumbnail (the engine's webp, loaded) for each new picture`, L);
    /* "@who" under a thumbnail comes from the engine's record of the upload; a file dropped straight on the share has none (so none is shown) */
    const WHO = await pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('#preview .sp-tile')].map((t) => [t.querySelector('.sp-nm')?.textContent, t.querySelector('.sp-mt')?.textContent])));
    ok(/^@me · /.test(WHO[`mine-${dev}.png`] ?? '') && !/^@/.test(WHO['sunset.png'] ?? '@'), `${dev}: your own uploaded picture reads "@me · when"; a file dropped on the share (no record) reads just the time`, { mine: WHO[`mine-${dev}.png`], dropped: WHO['sunset.png'] });
    await shot(pg, `${dev}-2-assets-list.png`);
    /* open the first new picture: the count drops by one, in the engine and on the line */
    await pg.click('#preview .sp-tile:has(.sp-dot) >> nth=0');
    await pg.waitForSelector('#preview .sp-iname', { timeout: 6000 }).catch(() => {});
    await sleep(1200);
    const c1 = await counts();
    ok(c1.assets.new === c0.assets.new - 1, `${dev}: opening it marks it seen: ${c0.assets.new} new -> ${c1.assets.new}`, c1.assets);
    await shot(pg, `${dev}-3-asset-open.png`);
    /* the ⋯ menu */
    await pg.click('#preview .sp-dots');
    await sleep(300);
    const M = await pg.evaluate(() => ({ items: [...document.querySelectorAll('#preview .sp-menu .sp-mi')].map((b) => b.textContent), vis: !document.querySelector('#preview .sp-menu')?.hidden }));
    ok(M.vis && M.items.join('|') === 'Rename…|Move to…|Remove…', `${dev}: the ⋯ menu: Rename, Move to, Remove`, M);
    await shot(pg, `${dev}-4-asset-menu.png`);
    if (verbs) {
      const cur = await pg.evaluate(() => document.querySelector('#preview .sp-iname')?.textContent);
      await pg.click('#preview .sp-menu .sp-mi >> nth=0');
      await pg.fill('#preview .sp-menu .sp-input', 'renamed-by-hand.png');
      await pg.click('#preview .sp-menu .sp-act.pri');
      await sleep(1200);
      const n1 = await names();
      ok(n1.includes('renamed-by-hand.png') && !n1.includes(cur), `${dev}: Rename acts on the real item (${cur} -> renamed-by-hand.png)`, n1);
      await pg.click('#preview .sp-tile:has(.sp-dot) >> nth=0');
      await pg.waitForSelector('#preview .sp-iname', { timeout: 6000 }).catch(() => {});
      const mv = await pg.evaluate(() => document.querySelector('#preview .sp-iname')?.textContent);
      await pg.click('#preview .sp-dots');
      await pg.click('#preview .sp-menu .sp-mi >> nth=1');
      await shot(pg, `${dev}-5-asset-move.png`);
      await pg.click('#preview .sp-menu .sp-mi:has-text("Shop")');
      await sleep(1200);
      ok((await names(SHOP)).includes(mv) && !(await names()).includes(mv), `${dev}: Move to the workgroup moves the real file (${mv})`, await names(SHOP));
      await pg.click('#preview .sp-tile >> nth=0');
      await pg.waitForSelector('#preview .sp-iname', { timeout: 6000 }).catch(() => {});
      const rm = await pg.evaluate(() => document.querySelector('#preview .sp-iname')?.textContent);
      await pg.click('#preview .sp-dots');
      await pg.click('#preview .sp-menu .sp-mi >> nth=2');
      await shot(pg, `${dev}-6-asset-remove.png`);
      await pg.click('#preview .sp-menu .sp-act.pri');
      await sleep(1200);
      ok(!(await names()).includes(rm), `${dev}: Remove takes the real item out of the list (${rm})`, await names());
    } else {
      await pg.keyboard.press('Escape');
    }
    /* notes: the card shows its author and tags; the opened note too */
    if (await pg.evaluate(() => !document.querySelector('#preview .sp-segb'))) {
      await pg.evaluate(() => document.querySelector('#preview .pv-back')?.click());
      await sleep(400);
    }
    await pg.click('#preview .sp-segb >> nth=1').catch(async () => { await pg.evaluate(() => document.querySelector('#preview .pv-back')?.click()); await sleep(300); await pg.click('#preview .sp-segb >> nth=1'); });
    await pg.waitForSelector('#preview .sp-note', { timeout: 6000 }).catch(() => {});
    await sleep(900);
    const N = await pg.evaluate(() => [...document.querySelectorAll('#preview .sp-note')].map((c) => ({ head: c.querySelector('.sp-nh')?.textContent, dot: !!c.querySelector('.sp-dot'), tags: [...c.querySelectorAll('.sp-tag')].map((x) => x.textContent), text: c.querySelector('.sp-nt')?.textContent.slice(0, 40) })));
    const fresh = N.filter((x) => x.dot);
    ok(N.length >= 3 && fresh.length >= 1 && N.every((x) => /\S/.test(x.head ?? '')) && N.some((x) => x.tags.length), `${dev}: note cards carry an author/when line and tags, the new ones a dot`, N.slice(0, 3));
    await shot(pg, `${dev}-7-notes-list.png`);
    const nb = (await counts()).notes.new;
    await pg.click('#preview .sp-note:has(.sp-dot) >> nth=0');
    await sleep(1200);
    const O = await pg.evaluate(() => ({ meta: document.querySelector('#preview .sp-imeta')?.textContent, tags: [...document.querySelectorAll('#preview .sp-tag')].map((x) => x.textContent), text: document.querySelector('#preview .sp-ntext, #preview .sp-ibody, #preview textarea')?.textContent?.slice(0, 40) ?? null }));
    ok(/@zahkutya/.test(O.meta ?? '') && (await counts()).notes.new === nb - 1, `${dev}: the opened note names its author and marks it seen (${nb} -> ${(await counts()).notes.new})`, O);
    await shot(pg, `${dev}-8-note-open.png`);
    await ctx.close();
  };
  await flow('phone', false);
  await flow('pc', true);
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  stub.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
