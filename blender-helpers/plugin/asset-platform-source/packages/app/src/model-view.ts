// ?model=<assetId> — one Library mesh, full page, nothing else: white background, ambient light only
// (plus a neutral environment so PBR metal has something to reflect; &env=0 turns it off), the file's
// own materials on three's standard shaders, the rest pose, no near clipping to speak of. One finger
// orbits, two fingers zoom and pan. &clip=<name or number> plays one of a GLB's own clips on a loop
// (framed on the rest pose); without it no clip is played. Two small corner controls (&ui=0 hides them):
// Parts (tick which top-level meshes show) and PBR / Metal — Metal draws ONLY the metalness map, as plain
// unlit grey (white = metal, black = not), to judge how cleanly a generator separated metal from the rest.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { load, shrinkTextures } from './components/MeshViewer';
import type { Asset } from './types';

const LIB_BASE = '/asset-management/library';
const BTN = 'font:13px system-ui,sans-serif;padding:5px 10px;border:1px solid #c5ccd6;border-radius:7px;background:rgba(255,255,255,.9);color:#1c2530;cursor:pointer';

// The metalness map (glTF: the blue channel) times the material's metalness factor, shown as its plain value.
function metalOf(m: THREE.Material): THREE.Material {
  const s = m as THREE.MeshStandardMaterial, k = typeof s.metalness === 'number' ? s.metalness : 0;
  const b = new THREE.MeshBasicMaterial({ map: s.metalnessMap || null, side: s.side });
  if (!s.metalnessMap) b.color.setRGB(k, k, k, THREE.SRGBColorSpace);
  else {
    b.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `diffuseColor.rgb = vec3( pow( texture2D( map, vMapUv ).b * ${k.toFixed(4)}, 2.2 ) );`);
    };
    b.customProgramCacheKey = () => 'metal' + k.toFixed(4);
  }
  return b;
}

function corner(root: THREE.Object3D, renderer: THREE.WebGLRenderer) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const modes = document.createElement('div');
  modes.style.cssText = 'position:fixed;right:10px;bottom:10px;display:flex;gap:6px';
  const set = (metal: boolean) => {
    for (const o of meshes) {
      const d = o.userData as { pbr?: THREE.Material | THREE.Material[]; metal?: THREE.Material | THREE.Material[] };
      d.pbr ??= o.material;
      if (metal) d.metal ??= Array.isArray(d.pbr) ? d.pbr.map(metalOf) : metalOf(d.pbr);
      o.material = metal ? d.metal! : d.pbr;
    }
    renderer.setClearColor(metal ? 0x2a3f58 : 0xffffff);   // white metal would vanish on the white page
    [...modes.children].forEach((b, i) => ((b as HTMLElement).style.outline = (i === 1) === metal ? '2px solid #14b8a6' : 'none'));
    (window as unknown as Record<string, unknown>).__modelMode = metal ? 'metal' : 'pbr';
  };
  [['PBR', 'Full materials'], ['Metal', 'Only the metalness map, as plain grey: white = metal, black = not metal']].forEach(([t, tip], i) => {
    const b = document.createElement('button');
    b.textContent = t; b.title = tip; b.style.cssText = BTN; b.onclick = () => set(i === 1);
    modes.appendChild(b);
  });
  document.body.appendChild(modes);
  set(false);

  // the parts: the top-level nodes that hold a mesh (past any single wrapper node)
  let top = root;
  while (top.children.length === 1 && !(top.children[0] as THREE.Mesh).isMesh) top = top.children[0];
  const parts = top.children.filter((c) => { let has = false; c.traverse((o) => { has ||= !!(o as THREE.Mesh).isMesh; }); return has; });
  if (parts.length < 2) return;
  const box = document.createElement('div'), open = document.createElement('button'), list = document.createElement('div');
  box.style.cssText = 'position:fixed;left:10px;top:10px;max-width:60%';
  open.style.cssText = BTN; open.setAttribute('aria-expanded', 'false'); open.textContent = '▸ Parts';
  list.style.cssText = 'display:none;margin-top:6px;padding:6px 10px;border:1px solid #c5ccd6;border-radius:7px;background:rgba(255,255,255,.92);color:#1c2530;font:13px system-ui,sans-serif;max-height:70vh;overflow:auto';
  open.onclick = () => {
    const on = list.style.display === 'none';
    list.style.display = on ? 'block' : 'none'; open.textContent = (on ? '▾' : '▸') + ' Parts'; open.setAttribute('aria-expanded', String(on));
  };
  parts.forEach((c, i) => {
    const row = document.createElement('label'), cb = document.createElement('input');
    row.style.cssText = 'display:flex;gap:7px;align-items:center;padding:3px 0;white-space:nowrap';
    cb.type = 'checkbox'; cb.checked = true; cb.onchange = () => { c.visible = cb.checked; };
    row.append(cb, c.name || `part ${i + 1}`);
    list.appendChild(row);
  });
  box.append(open, list);
  document.body.appendChild(box);
}

export async function start(id: string) {
  const q = new URLSearchParams(location.search);
  document.documentElement.style.cssText = 'height:100%;background:#fff';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#fff;overscroll-behavior:none';
  document.getElementById('root')?.remove();
  const note = document.createElement('div');
  note.style.cssText = 'position:fixed;left:0;right:0;top:45%;text-align:center;font:14px system-ui,sans-serif;color:#999;pointer-events:none';
  note.textContent = 'Loading…';
  document.body.appendChild(note);

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xffffff);
  renderer.domElement.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const env = q.get('env') !== '0';
  scene.add(new THREE.AmbientLight(0xffffff, env ? 1.6 : Math.PI));
  if (env) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
  }
  const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  const size = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', size);
  size();

  let mixer: THREE.AnimationMixer | undefined;
  const clock = new THREE.Clock();
  try {
    const row = await (await fetch(`${LIB_BASE}/api/assets/${encodeURIComponent(id)}`)).json();
    const asset = (row.asset || row) as Asset;
    const url = `${LIB_BASE}/api/assets/${asset.id}/file`;
    const fmt = (asset.format || asset.filename?.split('.').pop() || '').toLowerCase();
    let root: THREE.Object3D;
    if (fmt === 'glb' || fmt === 'gltf') {
      const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url, (e) => {
        if (e.total) note.textContent = `Loading ${Math.round((e.loaded / e.total) * 100)}%`;
      });
      shrinkTextures(g.scene);
      root = g.scene;
      const want = q.get('clip'), names = g.animations.map((a) => a.name);
      (window as unknown as Record<string, unknown>).__modelClips = names;
      if (want !== null && g.animations.length) {
        const clip = g.animations.find((a) => a.name.toLowerCase() === want.toLowerCase()) || g.animations[Number(want) || 0];
        root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });   // its box is the rest pose's
        mixer = new THREE.AnimationMixer(root);
        mixer.clipAction(clip).play();
      }
    } else root = (await load(asset, url)).root;
    scene.add(root);
    if (q.get('ui') !== '0') corner(root, renderer);
    const box = new THREE.Box3().setFromObject(root);
    const dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3()), r = dim.length() / 2 || 1;
    // far enough that both the height and the width fit (a T-pose is wider than a phone is)
    const t = Math.tan((camera.fov * Math.PI) / 360);
    const fit = Math.max(dim.y / 2 / t, dim.x / 2 / (t * camera.aspect)) * 1.08 + dim.z / 2;
    camera.near = r / 100000; camera.far = r * 1000;
    camera.position.copy(mid).add(new THREE.Vector3(0, 0, fit));
    camera.updateProjectionMatrix();
    controls.target.copy(mid);
    document.title = asset.label || asset.filename || 'Model';
    note.remove();
    (window as unknown as Record<string, unknown>).__modelReady = true;
  } catch (e) {
    note.textContent = `Could not load this model: ${String((e as Error)?.message || e)}`;
  }
  const tick = () => { requestAnimationFrame(tick); mixer?.update(clock.getDelta()); controls.update(); renderer.render(scene, camera); };
  tick();
}
