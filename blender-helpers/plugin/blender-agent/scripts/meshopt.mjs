#!/usr/bin/env node
/*
 * Meshopt-compress a GLB for three.js (gltfpack -cc), then prove three.js can
 * load it: GLTFLoader + MeshoptDecoder, the way a game would.
 *
 *   node scripts/meshopt.mjs <in.glb> <out.glb>
 *
 *   node scripts/meshopt.mjs <in.glb> <out.glb> [--scene] [-vpf | -vp N]   (--scene: a static scene is ok without skin/animation; -vpf float positions)
 * Prints one JSON line {ok, in_bytes, out_bytes, ratio, three:{skinned, bones,
 * morphs, animations, height}}. Tools live in tools/node (npm i gltfpack three).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/common.mjs';

const [input, output, ...extra] = process.argv.slice(2);
const sceneMode = extra.includes('--scene'); // a static scene (no skinned mesh, no animation): ok when three.js loads it
const packArgs = extra.filter((a) => a !== '--scene');
const okPack = (a) => /^-(vpf|vp|vt|vn|vc|tc|km|kn)$/.test(a) || /^\d{1,2}$/.test(a);
if (!packArgs.every(okPack)) { console.log(JSON.stringify({ ok: false, error: `gltfpack args not allowed: ${packArgs.join(' ')}` })); process.exit(1); }
const mods = path.join(ROOT, 'tools', 'node', 'node_modules');
const fail = (error) => {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(1);
};
if (!input || !output) fail('usage: meshopt.mjs <in.glb> <out.glb>');

// -cc: meshopt compression (higher ratio); -kn/-km: keep named nodes and materials
const r = spawnSync(process.execPath, [path.join(mods, 'gltfpack', 'cli.js'), '-i', input, '-o', output, '-cc', '-kn', '-km', ...packArgs],
  { encoding: 'utf8' });
if (r.status !== 0) fail(`gltfpack: ${(r.stderr || r.stdout).slice(-300)}`);

// node has no browser globals: GLTFLoader's EXT_texture_webp support check needs `self` and an `Image` that loads
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.Image === 'undefined') globalThis.Image = class { constructor() { this.height = 1; } set src(v) { queueMicrotask(() => this.onload && this.onload()); } };
const THREE = await import(pathToFileURL(path.join(mods, 'three', 'build', 'three.module.js')));
const { GLTFLoader } = await import(pathToFileURL(path.join(mods, 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js')));
const { MeshoptDecoder } = await import(pathToFileURL(path.join(mods, 'three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js')));

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
// node has no image decoding; textures are not what we check here
loader.register(() => ({ name: 'stub-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
const buf = fs.readFileSync(output);
const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej))
  .catch((e) => fail(`three GLTFLoader: ${e.message || e}`));

const skinned = [];
gltf.scene.traverse((o) => o.isSkinnedMesh && skinned.push(o));
gltf.scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(gltf.scene);
const three = {
  skinned: skinned.length,
  bones: skinned[0]?.skeleton.bones.length ?? 0,
  morphs: Object.keys(skinned[0]?.morphTargetDictionary ?? {}),
  animations: gltf.animations.map((a) => ({ name: a.name, secs: Math.round(a.duration * 100) / 100 })),
  height: Math.round((box.max.y - box.min.y) * 1000) / 1000,
};
let meshes = 0, lights = 0, nodes = 0;
gltf.scene.traverse((o) => { nodes++; if (o.isMesh) meshes++; if (o.isLight) lights++; });
const inBytes = fs.statSync(input).size;
const outBytes = fs.statSync(output).size;
console.log(JSON.stringify({ ok: sceneMode ? nodes > 1 : three.skinned > 0 && three.animations.length > 0, scene_mode: sceneMode, nodes, meshes, lights, in_bytes: inBytes, out_bytes: outBytes,
  ratio: Math.round((outBytes / inBytes) * 1000) / 1000, three }));
