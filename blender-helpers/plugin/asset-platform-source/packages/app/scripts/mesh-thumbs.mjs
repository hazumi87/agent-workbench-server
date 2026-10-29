// Mesh thumbnail backfill ("a thumbnail for each mesh brought into the library").
// Headless Chromium opens the Library SPA's ?thumbrender page — the same three.js loader, Synty
// materials and lights as the in-app 3D viewer — renders every mesh that has no thumbnail yet, and
// PUTs the JPEG back (PUT /api/assets/:id/thumb). Idempotent: meshes with a thumbnail are skipped.
//
//   node packages/app/scripts/mesh-thumbs.mjs [--base http://127.0.0.1:8260] [--limit N] [--collection slug,…] [--no-packs]
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:8260');
const LIMIT = Number(arg('--limit', Infinity));
const COLL = arg('--collection', '');
const API = `${BASE}/asset-management/library/api`;
const stamp = () => new Date().toISOString().slice(11, 19);

async function* meshes() {
  for (let off = 0; ; off += 1000) {
    const q = new URLSearchParams({ category: 'mesh', limit: '1000', offset: String(off), sort: 'oldest' });
    if (COLL) q.set('collection', COLL); else if (!process.argv.includes('--no-packs')) q.set('packs', '1');
    const j = await fetch(`${API}/assets?${q}`).then(r => r.json());
    for (const a of j.assets || []) yield a;
    if ((j.assets || []).length < 1000) return;
  }
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`${BASE}/asset-management/library/?thumbrender=1`);
await page.waitForFunction(() => typeof window.__renderThumb === 'function', null, { timeout: 30000 });

const n = { done: 0, skipped: 0, failed: 0, seen: 0 };
const t0 = Date.now();
for await (const a of meshes()) {
  if (n.done >= LIMIT) break;
  n.seen++;
  // only what the viewer can load; a .blend would be fetched whole and time out
  if (!['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'].includes(String(a.format || '').toLowerCase())) { n.skipped++; continue; }
  if ((await fetch(`${API}/assets/${a.id}/thumb`, { method: 'HEAD' })).status !== 404) { n.skipped++; continue; }
  try {
    const b64 = await Promise.race([page.evaluate(x => window.__renderThumb(x), a), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60000))]);
    const r = await fetch(`${API}/assets/${a.id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from(b64, 'base64') });
    if (!r.ok) throw new Error(`PUT ${r.status} ${await r.text()}`);
    n.done++;
  } catch (e) {
    n.failed++;
    console.log(`${stamp()} FAIL ${a.id} ${a.label}: ${String(e.message || e).slice(0, 160)}`);
    if (/Target closed|crashed/.test(String(e))) break;
  }
  if ((n.done + n.failed) % 100 === 0 && n.done + n.failed) console.log(`${stamp()} ${JSON.stringify(n)} ${((Date.now() - t0) / 1000 / (n.done + n.failed)).toFixed(2)} s/mesh`);
}
console.log(`${stamp()} DONE ${JSON.stringify(n)}`);
await browser.close();
