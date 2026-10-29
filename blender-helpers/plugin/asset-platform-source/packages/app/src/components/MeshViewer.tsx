// In-app 3D preview for a mesh asset (Mesh/Blender Studio outputs, Synty packs): orbit/zoom,
// the file's animation clips, and a slider per morph target (mouth shapes). Loaded lazily — three.js
// stays out of the main bundle. Synty FBX carry no textures; their Unity material data
// (meta.synty.materials, from the importer) supplies the albedo map + tint.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Asset } from '../types';
import { IconPause, IconPlay } from '../icons';

const LIB_BASE = '/asset-management/library';
export const VIEWABLE = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];

interface SyntyMat { name?: string; textures?: Record<string, string>; colors?: Record<string, number[]> }
const ALBEDO = ['_BaseMap', '_MainTex', '_Albedo', '_Texture', '_BaseColorMap'];

function syntyMaterials(asset: Asset): SyntyMat[] {
  const meta = typeof asset.meta === 'string' ? JSON.parse(asset.meta) : asset.meta;
  return ((meta as { synty?: { materials?: SyntyMat[] } } | null)?.synty?.materials) || [];
}

export async function load(asset: Asset, url: string): Promise<{ root: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const fmt = (asset.format || asset.filename?.split('.').pop() || '').toLowerCase();
  if (fmt === 'glb' || fmt === 'gltf') {
    const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    shrinkTextures(g.scene);
    return { root: g.scene, clips: g.animations };
  }
  if (fmt === 'fbx') {
    const f = await new FBXLoader().loadAsync(url);
    return { root: f, clips: f.animations };
  }
  if (fmt === 'obj') return { root: await new OBJLoader().loadAsync(url), clips: [] };
  const geo = await (fmt === 'stl' ? new STLLoader() : new PLYLoader()).loadAsync(url);
  geo.computeVertexNormals();
  return { root: new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8b8b8 })), clips: [] };
}

// Synty: the FBX names its materials after the Unity .mat — match by name, else the first one.
// Resolves once every texture it started has loaded (or failed) — the thumbnail waits on it.
function applySynty(root: THREE.Object3D, mats: SyntyMat[]): Promise<unknown> {
  if (!mats.length) return Promise.resolve();
  const tex = new Map<string, THREE.Texture>();
  const loads: Promise<unknown>[] = [];
  const textureFor = (id: string) => {
    if (!tex.has(id)) {
      let done: (v?: unknown) => void = () => {};
      loads.push(new Promise(r => { done = r; }));
      const t = new THREE.TextureLoader().load(`${LIB_BASE}/api/assets/${id}/file`, done, undefined, done);
      t.colorSpace = THREE.SRGBColorSpace;
      tex.set(id, t);
    }
    return tex.get(id)!;
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const out = list.map((mat) => {
      const s = mats.find((x) => x.name && mat.name && mat.name.startsWith(x.name)) || mats[0];
      const id = ALBEDO.map((k) => s.textures?.[k]).find((v) => v && /^[0-9a-f-]{36}$/.test(v));
      const c = s.colors?._Color || s.colors?._BaseColor;
      return new THREE.MeshStandardMaterial({ map: id ? textureFor(id) : null, color: c ? new THREE.Color(c[0], c[1], c[2]) : 0xffffff, roughness: 0.8 });
    });
    m.material = Array.isArray(m.material) ? out : out[0];
  });
  return Promise.all(loads);
}

// A 4096² map costs ~85 MB of GPU memory with mipmaps and a Scenario GLB carries three; the preview
// needs far less. Shrink before the first render (so the full size is never uploaded), and free
// everything on close — renderer.dispose() alone leaves geometry and textures to the GC, and a few
// models viewed in a row took the tab down ().
const TEX_MAX = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 1024 : 2048;

function eachTexture(root: THREE.Object3D, fn: (t: THREE.Texture) => void) {
  const seen = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        const t = v as THREE.Texture;
        if (t && t.isTexture && !seen.has(t)) { seen.add(t); fn(t); }
      }
    }
  });
}

export function shrinkTextures(root: THREE.Object3D) {
  eachTexture(root, (t) => {
    const img = t.image as (CanvasImageSource & { width: number; height: number; close?: () => void }) | null;
    if (!img || !img.width || Math.max(img.width, img.height) <= TEX_MAX) return;
    const k = TEX_MAX / Math.max(img.width, img.height);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    img.close?.();
    t.image = c;
    t.needsUpdate = true;
  });
}

function disposeTree(root: THREE.Object3D) {
  eachTexture(root, (t) => { (t.image as { close?: () => void } | null)?.close?.(); t.dispose(); });
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
}

// Thumbnails (): the same loader, materials and lights as the viewer, one still at a
// three-quarter view, 384² JPEG. Used lazily by the viewer and by the backfill worker
// (scripts/mesh-thumbs.mjs, via main.tsx's ?thumbrender hook).
const THUMB = 384;
export async function renderThumbnail(asset: Asset): Promise<Blob> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  let loaded: THREE.Object3D | null = null;
  try {
    renderer.setSize(THUMB, THUMB);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x1b1d22);
    const scene = new THREE.Scene();
    addLights(scene);
    const { root } = await load(asset, `${LIB_BASE}/api/assets/${asset.id}/file`);
    loaded = root;
    await Promise.race([applySynty(root, syntyMaterials(asset)), new Promise(r => setTimeout(r, 8000))]);
    scene.add(root);
    let meshes = 0;
    root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes++; });
    if (!meshes) throw new Error('no geometry (animation-only file?)');
    const box = new THREE.Box3().setFromObject(root);
    const dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const r = Math.max(dim.x, dim.y, dim.z) || 1;
    const camera = new THREE.PerspectiveCamera(30, 1, r / 100, r * 100);
    camera.position.copy(mid).add(new THREE.Vector3(r * 1.1, r * 0.6, r * 1.7));
    camera.lookAt(mid);
    renderer.render(scene, camera);
    return await new Promise<Blob>((res, rej) => renderer.domElement.toBlob(b => (b ? res(b) : rej(new Error('no image'))), 'image/jpeg', 0.85));
  } finally {
    if (loaded) disposeTree(loaded);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/** Stage mode (Model Studio, task): the viewer fills its parent box and draws only the model and
 *  the play/pause; the caption and shape keys are the host's, from onInfo. */
export interface StageInfo { tris: number; clip: string | null; morphs: string[]; setMorph: (k: string, v: number) => void }

export default function MeshViewer({ asset, stage }: { asset: Asset; stage?: { onInfo: (i: StageInfo) => void } }) {
  const host = useRef<HTMLDivElement>(null);
  const stageRef = useRef(stage); stageRef.current = stage;
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  const [info, setInfo] = useState<{ tris: number; size: number[] }>({ tris: 0, size: [0, 0, 0] });
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [morphs, setMorphs] = useState<Record<string, number>>({});
  const api = useRef<{ play: (i: number, on: boolean) => void; morph: (k: string, v: number) => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    addLights(scene);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const clock = new THREE.Clock();
    let mixer: THREE.AnimationMixer | null = null;
    let actions: THREE.AnimationAction[] = [];
    let morphMeshes: THREE.Mesh[] = [];
    let raf = 0, alive = true;

    const size = () => {
      const w = el.clientWidth, h = stageRef.current ? Math.max(1, el.clientHeight) : Math.round(w * 0.9);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    load(asset, `${LIB_BASE}/api/assets/${asset.id}/file`).then(({ root, clips }) => {
      if (!alive) { disposeTree(root); return; }
      applySynty(root, syntyMaterials(asset));
      scene.add(root);
      const box = new THREE.Box3().setFromObject(root);
      const dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
      const r = Math.max(dim.x, dim.y, dim.z) || 1;
      camera.position.copy(mid).add(new THREE.Vector3(0, r * 0.1, r * 2.2));
      camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
      controls.target.copy(mid);
      let tris = 0;
      const dict: Record<string, number> = {};
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        if (m.morphTargetDictionary) {
          morphMeshes.push(m);
          for (const [k, i] of Object.entries(m.morphTargetDictionary)) dict[k] = m.morphTargetInfluences?.[i] ?? 0;
        }
      });
      setInfo({ tris: Math.round(tris), size: [dim.x, dim.y, dim.z] });
      setMorphs(dict);
      if (clips.length) {
        mixer = new THREE.AnimationMixer(root);
        actions = clips.map((c) => mixer!.clipAction(c));
        actions[0].play();
      }
      setClips(clips.map((c) => c.name || 'clip'));
      api.current = {
        play: (i, on) => { actions.forEach((a, j) => { if (j === i) { a.paused = !on; if (!a.isRunning() && on) a.reset().play(); } else a.stop(); }); },
        morph: (k, v) => morphMeshes.forEach((m) => { const i = m.morphTargetDictionary?.[k]; if (i !== undefined && m.morphTargetInfluences) m.morphTargetInfluences[i] = v; }),
      };
      stageRef.current?.onInfo({ tris: Math.round(tris), clip: clips[0]?.name || (clips.length ? 'clip' : null), morphs: Object.keys(dict), setMorph: api.current.morph });
      setState('ready');
      fetch(`${LIB_BASE}/api/assets/${asset.id}/thumb`, { method: 'HEAD' }).then(h => {
        if (h.status !== 404 || !alive) return;
        return renderThumbnail(asset).then(b => fetch(`${LIB_BASE}/api/assets/${asset.id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: b }));
      }).catch(() => {});
    }).catch((e) => alive && setState(String(e?.message || e)));

    const tick = () => {
      raf = requestAnimationFrame(tick);
      mixer?.update(clock.getDelta());
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      el.removeChild(renderer.domElement);
    };
  }, [asset.id]);

  const fmt = (n: number) => (n >= 1 ? `${n.toFixed(2)} m` : `${(n * 100).toFixed(1)} cm`);
  const playBtn = state === 'ready' && clips.length > 0 && (
    <button className="mesh-play" data-testid="mesh-play" aria-label={playing ? 'Pause animation' : 'Play animation'} title={playing ? 'Pause' : 'Play'}
      onClick={() => { api.current?.play(clip, !playing); setPlaying(!playing); }}>
      {playing ? <IconPause /> : <IconPlay />}
    </button>
  );
  const onKey = (e: React.KeyboardEvent) => { if (e.key === ' ' && clips.length) { e.preventDefault(); api.current?.play(clip, !playing); setPlaying(!playing); } };
  if (stage) {
    return (
      <div className="mesh-stage" data-testid="av-mesh-viewer">
        <div ref={host} className="mesh-stage-host" tabIndex={0} aria-label="3D preview — drag to orbit; Space plays or pauses" onKeyDown={onKey} />
        {playBtn}
        {state === 'loading' && <div className="mesh-stage-msg">Loading the model…</div>}
        {state !== 'loading' && state !== 'ready' && <div className="mesh-stage-msg">Can't preview this file ({state}).</div>}
      </div>
    );
  }
  return (
    <div className="av-field" data-testid="av-mesh-viewer">
      <div style={{ position: 'relative' }}>
        <div ref={host} className="mesh-viewer" tabIndex={0} aria-label="3D preview — drag to orbit; Space plays or pauses"
          onKeyDown={onKey} style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: 'var(--surface-2, #1b1d22)', touchAction: 'none' }} />
        {/* play/pause overlaid bottom-right, in the mesh class colour on a dark backing. */}
        {playBtn}
      </div>
      {state === 'loading' && <div className="av-reftext-display">Loading the model…</div>}
      {state !== 'loading' && state !== 'ready' && <div className="av-reftext-display">Can't preview this file ({state}). Download it and open it in Blender.</div>}
      {state === 'ready' && (
        <>
          <div className="av-reftext-display">{info.tris.toLocaleString()} tris · {fmt(info.size[0])} × {fmt(info.size[1])} × {fmt(info.size[2])} (w × h × d) · drag to orbit, scroll or pinch to zoom</div>
          {clips.length > 0 && (
            <div className="av-field">
              <div className="av-field-label">Animation</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {clips.length > 1 && (
                  <select value={clip} onChange={(e) => { const i = Number(e.target.value); setClip(i); setPlaying(true); api.current?.play(i, true); }}>
                    {clips.map((c, i) => <option key={i} value={i}>{c}</option>)}
                  </select>
                )}
                {clips.length === 1 && <span>{clips[0]}</span>}
              </div>
            </div>
          )}
          {Object.keys(morphs).length > 0 && (
            <div className="av-field">
              <div className="av-field-label">Shape keys</div>
              {Object.entries(morphs).map(([k, v]) => (
                <label key={k} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 6.5em) minmax(0, 1fr) 2.8em', gap: 6, alignItems: 'center' }}>
                  <span>{k}</span>
                  <input type="range" min={0} max={1} step={0.01} value={v}
                    onChange={(e) => { const n = Number(e.target.value); setMorphs({ ...morphs, [k]: n }); api.current?.morph(k, n); }} />
                  <span>{v.toFixed(2)}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
