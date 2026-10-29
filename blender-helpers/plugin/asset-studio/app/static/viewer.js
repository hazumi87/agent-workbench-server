/*
 * The panel's 3D viewer — vanilla JS, no framework. An ES module served at
 * GET /rooms/:roomId/viewer.js and imported by view.js and review.js by an ABSOLUTE URL built
 * from location.href (a classic script in an opaque-origin frame has no base URL for import()).
 * It imports three.js r180 from ./vendor/ (MIT, vendor/LICENSE). From the sandboxed frame every
 * module and the GLB fetch are CORS requests — the app answers access-control-allow-origin: *.
 *
 * Lighting and camera follow the Library's MeshViewer (packages/app/src/components/MeshViewer.tsx):
 * a hemisphere light + one sun, a 35° camera auto-fit to the model's bounding box, orbit with
 * damping. A GLB with embedded animations or poses gets a picker + Play / Stop (below); it stands in its
 * rest pose until Play. Meshopt-compressed GLBs decode through the vendored meshopt decoder (wasm, no workers).
 *
 *   animations      el.dataset.anim = none | rest | playing | paused, el.dataset.clip = the selected clip's name.
 *                   .mv-anim holds a <select class="mv-clip"> of every clip in the file, ▶ / ❚❚ (.mv-play) and ■ (.mv-stop):
 *                   Play starts the selected clip (looping), pressed again it pauses; Stop returns every node to the transform
 *                   it had at load (the rest / T-pose). Picking another clip while one plays plays that one. The pick and
 *                   whether it was playing survive load() by clip name. Handle: clips(), play(), stop(), chooseClip(name),
 *                   clipIndex(), animation(). 'mv-anim' fires on el whenever the state changes. mount(el, url, {anim:false}) leaves
 *                   the row off the canvas; animRow(handle, el) (exported) builds one for the caller to put where it has room.
 *                   dispose() stops the actions, drops the mixer and takes the row it made off.
 *   pins            pick(clientX, clientY) -> {point (the GLB's scene frame), local, normal, node, path, triangle, barycentric, distance, transparent} | null | {error:'animated'};
 *                   setPreview(hit) draws a ring on the surface; setPins([{id, label, point, selected?, draft?}]) draws constant-size tags with a stem and dot (occluded = 50% and
 *                   a dashed stem); 'mv-pin' {id} fires on a tag press; viewState() / restoreView({cam, hidden}); isolate(name) / showAll() / hiddenCount() over the parts.
 *   'mv-error'      fires on el (detail = a short reason) when the model could not be shown; the page may replace the stage with its own message.
 *
 *   mount(el, url, opts) -> {dispose(), load(url), setCamera(pose), camera(), glbCameras(), setMode(id, alpha?), setReference(url, names?),
 *                           setReferenceVisible(on), parts(), setVisible(name, on), mode()}
 *                                   el: a box whose SIZE the page sets (px, never vh); the
 *                                   canvas fills it. el.dataset.state = loading | ready | error,
 *                                   el.dataset.tris = the triangle count once loaded, el.dataset.cam =
 *                                   the camera as JSON {p, t, fov} (position, target, vertical degrees),
 *                                   kept current as it moves. An 'mv-ready' event fires on el after
 *                                   every successful load. el.dataset.mode = the view mode on show,
 *                                   el.dataset.ref = none | loading | ready | error (the reference file),
 *                                   el.dataset.vis = what is on show, as JSON (for tests and the eye):
 *                                   {parts, refSolid, refGrid, refMap, refOpacity, wire, normals, grey} — counts
 *                                   of the model's visible meshes, of the reference's visible solid / grid
 *                                   objects and of the visible model meshes drawn wireframe / with a normal
 *                                   map / in the flat grey.
 *   load(url)       swaps in another model and KEEPS the camera where the user has put it (the Watch
 *                   tab reloads the preview model on every step); only the first load fits the camera.
 *   setCamera(pose) snap to {position:[x,y,z], target:[x,y,z], fov?}; the user orbits on from there.
 *   glbCameras()    the camera nodes inside the loaded GLB: {name: {position, target, fov}}, target =
 *                   along the node's view direction, as far as the model's centre.
 *   setMode(id, a)  how the model is drawn, no reload and no camera move; kept across load():
 *                     pbr      the file's own materials     lit      the same without normal maps
 *                     color    reference solid grey, model as lit
 *                     wire     reference in its colour at opacity a (default 0.5), model as yellow wireframe
 *                     refwire  reference as cyan grid lines, model solid grey
 *                   (the reference only while it is ticked on: setReferenceVisible; a failed load turns it off
 *                   again and a color / wire / refwire mode with it)
 *                   Materials are swapped, never edited: the file's own stay on the mesh for pbr.
 *   parts()         the model's parts, its top-level nodes with a mesh: [{name, visible}]; setVisible(name, on) shows or hides
 *                   one (kept by name across load(); a part new to a load starts shown).
 *   setReferenceVisible(on)  the reference is drawn only while this is on (default off), in every mode: with its
 *                   own materials in pbr, without normal maps in lit, and as the mode says in color / wire / refwire
 *                   (the solid in all but refwire, the grid lines in refwire).
 *   setReference(u, {solid, grid})  the reference file (node names; default ref and ref-grid), loaded the first
 *                   time it is ticked on; null drops it. When it can't
 *                   be loaded the mode falls back to lit, the label line says so and 'mv-reffail' fires.
 */
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';

function label(el, text) {
  var s = el.querySelector('.mv-st');
  if (!s) {
    s = document.createElement('div');
    s.className = 'mv-st';
    el.appendChild(s);
  }
  s.textContent = text;
}

export function mount(el, url, opts) {
  opts = opts || {};
  var alive = true;
  var raf = 0;
  el.dataset.state = 'loading';
  label(el, 'Loading the model…');
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    el.dataset.state = 'error';
    label(el, 'No WebGL here — open it in the Library.');
    setTimeout(function () { el.dispatchEvent(new CustomEvent('mv-error', { detail: 'this device cannot draw 3D (no WebGL)' })); }, 0); // after the caller has a listener
    return { dispose: function () {}, load: function () {}, setCamera: function () {}, camera: function () { return null; }, glbCameras: function () { return {}; }, setMode: function () {}, setReference: function () {}, setReferenceVisible: function () {}, parts: function () { return []; }, setVisible: function () {}, mode: function () { return 'pbr'; }, clips: function () { return []; }, play: function () {}, stop: function () {}, chooseClip: function () {}, clipIndex: function () { return 0; }, animation: function () { return 'none'; }, pick: function () { return null; }, setPreview: function () {}, setPins: function () {}, viewState: function () { return null; }, restoreView: function () {}, isolate: function () {}, showAll: function () {}, hiddenCount: function () { return 0; } };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '3D preview — drag to orbit, scroll or pinch to zoom');
  el.insertBefore(renderer.domElement, el.firstChild);
  var scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 2.2));
  var sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  var camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  var controls = new OrbitControls(camera, renderer.domElement);
  controls.addEventListener('start', function () { touched = true; });
  controls.enableDamping = true;
  var clock = new THREE.Clock();
  var mixer = null;
  var action = null;
  var current = null; // the model on stage
  var cams = {};
  var seq = 0; // the newest load wins
  var fitted = false;
  var fitBox = null; // {mid, dim, r, rs}: the model's centre, size, largest dimension and bounding-sphere radius, for the start view
  var touched = false; // the user (or a restored view) moved the camera: the start view stops following the stage's size
  var mode = 'pbr';
  var hidden = {}; // part name -> true: unticked in the parts list; kept across load() by name
  var refOn = false; // the reference ticked
  var alpha = 0.5; // the reference's opacity in wire
  var ref = null; // {url, solid, grid, state: none | loading | ready | error, root, nodes: {solid, grid}}
  var refSeq = 0;
  var base = ''; // the label line without the reference note
  var note = '';
  var shared = {}; // grey, wire, grid: one material each, for every mesh that wears it
  var modelR = 1; // the model's largest dimension (scales the pin ring)
  el.dataset.mode = mode;
  el.dataset.ref = 'none';

  function size() {
    var w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (fitBox && !touched) fit(); // the stage was laid out after the model came in: fit it again
  }
  /* The start view: the model fits the stage at ANY aspect (distance from the narrower of the vertical and horizontal fields of view),
     seen from an elevated three-quarter angle so a room shows its inside (a figure, taller than its thinner horizontal extent, along that axis instead); or the GLB's own first camera when it has one. */
  function fit() {
    var f = fitBox, names = Object.keys(cams);
    if (names.length) {
      var c0 = cams[names[0]];
      camera.position.fromArray(c0.position);
      controls.target.fromArray(c0.target);
    } else {
      var vf = (camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
      var d = (f.rs / Math.sin(Math.min(vf, hf) / 2)) * 1.08;
      // a figure (taller than its THINNER horizontal extent, so a T-pose counts) is seen along that thin axis, broad side to the camera,
      // a little raised; a room or a prop from an elevated three-quarter angle
      var tall = f.dim.y > 1.2 * Math.min(f.dim.x, f.dim.z);
      var front = f.dim.z <= f.dim.x ? new THREE.Vector3(0, 0.18, 1) : new THREE.Vector3(1, 0.18, 0);
      camera.position.copy(f.mid).addScaledVector((tall ? front : new THREE.Vector3(0.55, 0.75, 0.75)).normalize(), d);
      controls.target.copy(f.mid);
    }
    camera.near = f.r / 100;
    camera.far = f.r * 100 + camera.position.distanceTo(f.mid);
    camera.updateProjectionMatrix();
    controls.update();
    report();
  }
  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null;
  if (ro) ro.observe(el);
  size();

  /* ---- animations (): the clips (and one-frame poses) embedded in the GLB, a picker, Play / Stop. The model
     stands in its rest pose (the file's own node transforms, recorded at load) until Play; Stop goes back to it. The
     choice and whether it was playing are kept by clip name across load() (the Watch tab reloads on every step). */
  var clips = []; // the loaded file's AnimationClips
  var rest = []; // [{o, p, q, s}]: every node's transform as loaded, before any clip touched it
  var pick = 0; // the selected clip
  var anim = 'rest'; // rest | playing | paused
  var want = { name: '', playing: false };
  var overlay = null; // the control row this viewer put over its own canvas (unless opts.anim === false)
  function clipLabel(c, i) {
    return c.name || 'clip ' + (i + 1);
  }
  function animState(s) {
    anim = s;
    el.dataset.anim = s;
    el.dataset.clip = clips.length ? clipLabel(clips[pick], pick) : '';
    want = { name: clips.length ? clipLabel(clips[pick], pick) : '', playing: s === 'playing' };
    el.dispatchEvent(new Event('mv-anim')); // a control row repaints itself
  }
  function playClip() {
    if (!mixer || !clips.length) return;
    if (anim === 'playing') {
      action.paused = true;
      return animState('paused');
    }
    if (anim === 'paused') {
      action.paused = false;
      return animState('playing');
    }
    action = mixer.clipAction(clips[pick]);
    action.reset().play();
    animState('playing');
  }
  function stopClip() {
    if (!mixer) return;
    mixer.stopAllAction();
    rest.forEach(function (r) {
      r.o.position.copy(r.p);
      r.o.quaternion.copy(r.q);
      r.o.scale.copy(r.s);
    });
    if (current) current.updateMatrixWorld(true);
    animState('rest');
  }
  function chooseClip(i) {
    if (!clips[i]) return;
    var was = anim === 'playing';
    if (anim !== 'rest') stopClip();
    pick = i;
    animState('rest');
    if (was) playClip();
  }
  function r4(n) {
    return Math.round(n * 1e4) / 1e4;
  }
  function pose() {
    var p = camera.position, t = controls.target;
    return { position: [r4(p.x), r4(p.y), r4(p.z)], target: [r4(t.x), r4(t.y), r4(t.z)], fov: r4(camera.fov) };
  }
  function report() {
    var c = pose();
    el.dataset.cam = JSON.stringify({ p: c.position, t: c.target, fov: c.fov });
  }
  function setCamera(c) {
    if (!c || !c.position || !c.target) return;
    camera.position.fromArray(c.position);
    controls.target.fromArray(c.target);
    if (c.fov > 0 && c.fov < 180) camera.fov = c.fov;
    touched = true;
    camera.updateProjectionMatrix();
    controls.update();
    report();
  }
  function free(root) {
    root.traverse(function (o) {
      if (!o.isMesh && !o.isLine) return;
      o.geometry.dispose();
      [].concat(o.userData.mvOrig || o.material).forEach(function (m) { // the file's own, even while a mode has others on
        Object.keys(m).forEach(function (k) {
          if (m[k] && m[k].isTexture) m[k].dispose();
        });
        m.dispose();
      });
    });
    var made = root.userData.mvMade || {};
    Object.keys(made).forEach(function (k) { made[k].dispose(); }); // copies share the file's textures: material only
    root.userData.mvMade = {};
  }

  /* ---- view modes: swap materials, keep the file's own on o.userData.mvOrig */
  function mat(name) {
    if (!shared[name]) {
      shared[name] = name === 'grey' ? new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1, metalness: 0, side: THREE.DoubleSide })
        : name === 'wire' ? new THREE.MeshBasicMaterial({ color: 0xffe000, wireframe: true })
        : new THREE.LineBasicMaterial({ color: 0x00e5ff });
    }
    return shared[name];
  }
  /* a copy of one of the file's materials without its normal map (and, for 'ghost', see-through); freed with its root */
  function copy(root, m, kind) {
    var made = root.userData.mvMade || (root.userData.mvMade = {});
    var k = kind + m.uuid;
    if (!made[k]) {
      var c = made[k] = m.clone();
      c.normalMap = null;
      if (kind === 'ghost') {
        c.transparent = true;
        c.opacity = alpha;
        c.depthWrite = false;
      }
      c.needsUpdate = true;
    }
    return made[k];
  }
  function wear(root, o, f) { // f(the file's material) -> the one to draw with
    var own = o.userData.mvOrig || (o.userData.mvOrig = o.material);
    o.material = Array.isArray(own) ? own.map(f) : f(own);
  }
  var NEEDS_REF = { color: 1, wire: 1, refwire: 1 };
  /* the model's parts: its top-level nodes that hold a mesh (cameras and the like are not parts) */
  function hasMesh(c) {
    var yes = false;
    c.traverse(function (o) { if (o.isMesh) yes = true; });
    return yes;
  }
  function tops() {
    return current ? current.children.filter(hasMesh) : [];
  }
  function partName(c, i) {
    return c.name || 'part ' + (i + 1);
  }
  /* what is drawn, and how: the ticks (hidden, refOn) decide what, the mode how */
  function dress() {
    var vis = { parts: 0, refSolid: 0, refGrid: 0, refMap: 0, refOpacity: 0, wire: 0, normals: 0, grey: 0 };
    if (current) {
      tops().forEach(function (c, i) { c.visible = !hidden[partName(c, i)]; });
      current.traverse(function (o) {
        if (!o.isMesh) return;
        wear(current, o, function (m) {
          return mode === 'wire' ? mat('wire') : mode === 'refwire' ? mat('grey') : mode === 'pbr' ? m : copy(current, m, 'lit');
        });
      });
      current.traverseVisible(function (o) {
        if (!o.isMesh) return;
        vis.parts++;
        [].concat(o.material).forEach(function (m) {
          if (m.wireframe) vis.wire++;
          if (m.normalMap) vis.normals++;
          if (m === shared.grey) vis.grey++;
        });
      });
    }
    if (ref && ref.root) {
      var n = ref.nodes;
      if (n.solid) {
        n.solid.visible = refOn && mode !== 'refwire';
        n.solid.traverse(function (o) {
          if (!o.isMesh) return;
          wear(ref.root, o, function (m) {
            return mode === 'wire' ? copy(ref.root, m, 'ghost') : mode === 'color' ? mat('grey') : mode === 'lit' ? copy(ref.root, m, 'lit') : m;
          });
          if (!n.solid.visible) return;
          var m0 = [].concat(o.material)[0];
          vis.refSolid++;
          if (m0.map) vis.refMap++;
          vis.refOpacity = m0.transparent ? m0.opacity : 1;
        });
      }
      if (n.grid) {
        n.grid.visible = refOn && mode === 'refwire';
        n.grid.traverse(function (o) {
          if (!o.isLine) return;
          wear(ref.root, o, function () { return mat('grid'); });
          if (n.grid.visible) vis.refGrid++;
        });
      }
    }
    el.dataset.mode = mode;
    el.dataset.vis = JSON.stringify(vis);
  }
  function status() {
    if (el.dataset.state === 'ready') label(el, base + (note ? ' · ' + note : ''));
  }
  function dropRef() {
    refSeq++;
    if (ref && ref.root) {
      scene.remove(ref.root);
      free(ref.root);
    }
    ref = null;
    note = '';
    el.dataset.ref = 'none';
  }
  function loadRef() {
    var r = ref;
    var mine = ++refSeq;
    r.state = 'loading';
    el.dataset.ref = 'loading';
    note = 'loading the reference…';
    status();
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(r.url).then(function (g) {
      if (!alive || mine !== refSeq) return;
      g.scene.updateMatrixWorld(true);
      var root = new THREE.Group(); // only the two named nodes stay, in the place they had in the file
      var nodes = { solid: g.scene.getObjectByName(r.solid) || null, grid: g.scene.getObjectByName(r.grid) || null };
      if (!nodes.solid && !nodes.grid) {
        free(g.scene);
        throw new Error('no "' + r.solid + '" or "' + r.grid + '" in the file');
      }
      Object.keys(nodes).forEach(function (k) {
        if (nodes[k]) root.attach(nodes[k]);
      });
      free(g.scene); // whatever else the file held
      r.root = root;
      r.nodes = nodes;
      r.state = 'ready';
      el.dataset.ref = 'ready';
      note = '';
      scene.add(root);
      dress();
      status();
    }).catch(function (e) {
      if (!alive || mine !== refSeq) return;
      r.state = 'error';
      el.dataset.ref = 'error';
      var was = NEEDS_REF[mode];
      if (was) mode = 'lit';
      refOn = false;
      dress();
      note = "can't load the reference (" + String((e && e.message) || e).slice(0, 60) + ')' + (was ? ' — showing Lit' : '');
      status();
      el.dispatchEvent(new Event('mv-reffail'));
    });
  }
  function setMode(id, a) {
    if (id !== 'pbr' && id !== 'lit' && !NEEDS_REF[id]) return;
    if (typeof a === 'number' && a > 0 && a <= 1 && a !== alpha) {
      alpha = a;
      if (ref && ref.root) Object.keys(ref.root.userData.mvMade || {}).forEach(function (k) { if (k.indexOf('ghost') === 0) ref.root.userData.mvMade[k].opacity = alpha; });
      dress();
    }
    if (id === mode && !(NEEDS_REF[id] && ref && ref.state === 'error')) return;
    mode = id;
    wantRef();
    dress();
  }
  /* the reference is fetched the first time it is to be drawn (ticked on), once */
  function wantRef() {
    if (refOn && ref && (ref.state === 'none' || ref.state === 'error')) loadRef();
  }
  function setReferenceVisible(on) {
    on = !!on;
    if (on === refOn) return;
    refOn = on;
    wantRef();
    dress();
  }
  function parts() {
    var seen = {};
    return tops().map(function (c, i) { return partName(c, i); }).filter(function (n) { return !seen[n] && (seen[n] = 1); }).map(function (n) { return { name: n, visible: !hidden[n] }; });
  }
  function setVisible(name, on) {
    if (on) delete hidden[name];
    else hidden[name] = true;
    dress();
  }
  /* ---- picking and pins (unified review P3, ): drop a pin on the model's SOLID surface ---- */
  var raycaster = new THREE.Raycaster();
  var ring = null; // the target preview: a ring lying on the surface under the pointer
  var pinList = [], occAt = 0, pinLayer = null, pinSvg = null;
  function deepVisible(o) {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  }
  function nodeName(o) {
    for (; o && o !== current; o = o.parent) {
      var n = (o.userData && o.userData.name) || o.name;
      if (n) return n;
    }
    return '';
  }
  function nodePath(o) {
    var out = [];
    for (; o && o !== current; o = o.parent) {
      var n = (o.userData && o.userData.name) || o.name;
      if (n) out.unshift(n);
    }
    return out;
  }
  var r5 = function (n) { return Math.round(n * 1e5) / 1e5; }; // 0.01 mm when the unit is a metre
  var a3 = function (v) { return [r5(v.x), r5(v.y), r5(v.z)]; };
  /* the nearest VISIBLE mesh surface along a ray (what the user sees and so can mean): hidden parts are not hit, nor is the reference */
  function firstHit(origin, dir, far) {
    if (!current) return null;
    raycaster.set(origin, dir);
    raycaster.far = far || Infinity;
    var hits = raycaster.intersectObject(current, true);
    for (var i = 0; i < hits.length; i++) if (hits[i].object.isMesh && deepVisible(hits[i].object)) return hits[i];
    return null;
  }
  /* a hit as the review keeps it: the point in the GLB's own scene frame (this viewer adds the scene untouched: no recentering, no display
     scale is applied to the model, so this IS the glTF scene frame, Y up, metres), the same in the mesh's local frame, the surface normal,
     the node it belongs to, the triangle and the barycentric coordinates in it */
  function describe(hit) {
    var o = hit.object, p = hit.point;
    var n = hit.face ? hit.face.normal.clone().transformDirection(o.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
    var bary = null;
    if (hit.face && o.getVertexPosition) {
      var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t = new THREE.Vector3();
      o.getVertexPosition(hit.face.a, a).applyMatrix4(o.matrixWorld);
      o.getVertexPosition(hit.face.b, b).applyMatrix4(o.matrixWorld);
      o.getVertexPosition(hit.face.c, c).applyMatrix4(o.matrixWorld);
      THREE.Triangle.getBarycoord(p, a, b, c, t);
      bary = a3(t);
    }
    var m = [].concat(o.userData.mvOrig || o.material)[0];
    return { point: a3(p), local: a3(o.worldToLocal(p.clone())), normal: a3(n), node: nodeName(o), path: nodePath(o), triangle: hit.faceIndex === undefined ? null : hit.faceIndex, barycentric: bary,
      distance: r5(hit.distance), transparent: !!(m && m.transparent && m.opacity < 1) };
  }
  /* pick(clientX, clientY): what is under the pointer — a hit (see describe), null when nothing solid is (off the model, a background drop:
     NO mark, never a bounding box or a rear surface through a visible foreground object), or {error:'animated'} while a clip is playing */
  function pickAt(cx, cy) { // (not `pick`: that is the selected clip's index above)
    if (!current) return null;
    if (anim === 'playing' || anim === 'paused') return { error: 'animated' };
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var x = ((cx - r.left) / r.width) * 2 - 1, y = -(((cy - r.top) / r.height) * 2 - 1);
    if (x < -1 || x > 1 || y < -1 || y > 1) return null;
    camera.updateMatrixWorld();
    raycaster.setFromCamera({ x: x, y: y }, camera);
    raycaster.far = Infinity;
    var hits = raycaster.intersectObject(current, true);
    for (var i = 0; i < hits.length; i++) if (hits[i].object.isMesh && deepVisible(hits[i].object)) return describe(hits[i]);
    return null;
  }
  /* the target preview: a ring lying flat on the surface (oriented to the normal); null / no hit hides it */
  function setPreview(info) {
    if (!info || info.error) {
      if (ring) ring.visible = false;
      return;
    }
    if (!ring) {
      ring = new THREE.Group();
      var dark = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 48), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -4 }));
      var light = new THREE.Mesh(new THREE.RingGeometry(1, 1.28, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -4 }));
      ring.add(dark, light);
      ring.renderOrder = 998;
      scene.add(ring);
    }
    var s = modelR * 0.012, p = new THREE.Vector3().fromArray(info.point), n = new THREE.Vector3().fromArray(info.normal);
    ring.scale.setScalar(s);
    ring.position.copy(p).addScaledVector(n, s * 0.06);
    ring.lookAt(p.clone().add(n));
    ring.visible = true;
  }
  /* pins: [{id, label, point:[x,y,z] (scene frame), selected?, draft?}] drawn as DOM tags over the canvas — constant on-screen size,
     always facing the viewer, a stem down to a dot on the surface; a pin behind nearer surface stays visible at half strength with a dashed
     stem (it does not vanish, and does not draw as if it were in front). A tag press fires 'mv-pin' {id}. A pin with menu: [{k, label, off?}]
     shows it under its letter; a press on an item fires 'mv-pinmenu' {id, k}. */
  function setPins(list) {
    pinList = (list || []).map(function (q) { return { id: q.id, label: q.label, point: new THREE.Vector3().fromArray(q.point), selected: !!q.selected, draft: !!q.draft, menu: Array.isArray(q.menu) ? q.menu : null, occ: false, tag: null, dot: null, line: null }; });
    if (!pinLayer) {
      pinLayer = document.createElement('div');
      pinLayer.className = 'mv-pins';
      pinSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pinSvg.setAttribute('class', 'mv-pstems');
      pinSvg.setAttribute('aria-hidden', 'true');
      pinLayer.appendChild(pinSvg);
      el.appendChild(pinLayer);
    }
    while (pinLayer.children.length > 1) pinLayer.removeChild(pinLayer.lastChild);
    while (pinSvg.firstChild) pinSvg.removeChild(pinSvg.firstChild);
    pinList.forEach(function (q) {
      q.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      pinSvg.appendChild(q.line);
      q.dot = document.createElement('i');
      q.dot.className = 'mv-pdot';
      q.tag = document.createElement('button');
      q.tag.type = 'button';
      q.tag.className = 'mv-pin';
      q.tag.textContent = q.label;
      q.tag.setAttribute('data-pin', q.id);
      q.tag.setAttribute('aria-label', 'Pin ' + q.label);
      q.tag.addEventListener('click', function (e) {
        e.stopPropagation();
        el.dispatchEvent(new CustomEvent('mv-pin', { detail: { id: q.id } }));
      });
      pinLayer.appendChild(q.dot);
      pinLayer.appendChild(q.tag);
      if (q.menu) { // the tapped pin's menu, at its letter: [{k, label, off?}] — a press fires 'mv-pinmenu' {id, k}
        q.menuEl = document.createElement('div');
        q.menuEl.className = 'mv-pmenu';
        q.menuEl.setAttribute('role', 'menu');
        q.menuEl.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // not the start of an orbit
        q.menu.forEach(function (it) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn';
          b.textContent = it.label;
          b.disabled = !!it.off;
          b.setAttribute('role', 'menuitem');
          b.setAttribute('data-pmk', it.k);
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            el.dispatchEvent(new CustomEvent('mv-pinmenu', { detail: { id: q.id, k: it.k } }));
          });
          q.menuEl.appendChild(b);
        });
        pinLayer.appendChild(q.menuEl);
      }
    });
    occAt = 0;
  }
  function updatePins(now) {
    if (!pinLayer || !pinList.length) return;
    var w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    var recheck = now - occAt > 150;
    if (recheck) occAt = now;
    var report = [];
    pinList.forEach(function (q) {
      var v = q.point.clone().project(camera);
      var inView = v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      var sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      if (recheck && inView) {
        var dir = q.point.clone().sub(camera.position), dist = dir.length();
        var hit = firstHit(camera.position, dir.normalize(), dist + modelR);
        q.occ = !!hit && hit.distance < dist - modelR * 0.004;
      }
      var tx = Math.min(Math.max(sx + 18, 16), w - 16), ty = Math.max(sy - 34, 16);
      q.tag.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px)';
      q.dot.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
      q.line.setAttribute('x1', sx.toFixed(1));
      q.line.setAttribute('y1', sy.toFixed(1));
      q.line.setAttribute('x2', tx.toFixed(1));
      q.line.setAttribute('y2', ty.toFixed(1));
      if (q.menuEl) { // under its letter, kept inside the stage (above it when there is no room below)
        var mw = q.menuEl.offsetWidth, mh = q.menuEl.offsetHeight;
        var mx = Math.min(Math.max(tx - 12, 4), Math.max(4, w - mw - 4)), my = ty + 18 + mh > h - 4 ? Math.max(4, ty - 18 - mh) : ty + 18;
        q.menuEl.style.transform = 'translate(' + mx.toFixed(1) + 'px,' + my.toFixed(1) + 'px)';
        q.menuEl.hidden = !inView;
      }
      q.tag.hidden = q.dot.hidden = !inView;
      q.line.style.display = inView ? '' : 'none';
      q.tag.classList.toggle('occ', q.occ);
      q.dot.classList.toggle('occ', q.occ);
      q.line.classList.toggle('occ', q.occ);
      q.tag.classList.toggle('sel', q.selected);
      q.tag.classList.toggle('draft', q.draft);
      report.push({ id: q.id, occ: q.occ, inView: inView, x: Math.round(sx), y: Math.round(sy) });
    });
    if (recheck) el.dataset.pins = JSON.stringify(report); // for tests and the eye
  }
  /* the view a pin is saved with: the camera and which parts were hidden; restoreView puts both back */
  function viewState() {
    return { cam: pose(), hidden: Object.keys(hidden) };
  }
  function restoreView(s) {
    if (!s) return;
    Object.keys(hidden).forEach(function (k) { delete hidden[k]; });
    (s.hidden || []).forEach(function (n) { hidden[n] = true; });
    dress();
    if (s.cam) setCamera(s.cam);
    occAt = 0;
  }
  function isolate(name) {
    parts().forEach(function (q) {
      if (q.name === name) delete hidden[q.name];
      else hidden[q.name] = true;
    });
    dress();
    occAt = 0;
  }
  function showAll() {
    Object.keys(hidden).forEach(function (k) { delete hidden[k]; });
    dress();
    occAt = 0;
  }
  function setReference(u, names) {
    if (!u) {
      if (ref) dropRef();
      return;
    }
    names = names || {};
    var solid = names.solid || 'ref', grid = names.grid || 'ref-grid';
    if (ref && ref.url === u && ref.solid === solid && ref.grid === grid) return;
    if (ref) dropRef();
    ref = { url: u, solid: solid, grid: grid, state: 'none', root: null, nodes: {} };
    wantRef();
  }

  function load(u) {
    var mine = ++seq;
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(u).then(function (g) {
      if (!alive || mine !== seq) return;
      if (current) {
        scene.remove(current);
        free(current);
      }
      var root = (current = g.scene);
      scene.add(root);
      dress();
      root.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(root);
      var dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
      var r = Math.max(dim.x, dim.y, dim.z) || 1;
      modelR = r;
      var first = !fitted;
      if (first) {
        fitted = true;
        fitBox = { mid: mid, dim: dim, r: r, rs: box.getBoundingSphere(new THREE.Sphere()).radius || r };
      }
      cams = {};
      (g.cameras || []).forEach(function (c) {
        if (!c.name) return;
        var at = c.getWorldPosition(new THREE.Vector3());
        var ahead = c.getWorldDirection(new THREE.Vector3());
        cams[c.name] = { position: at.toArray(), target: at.clone().addScaledVector(ahead, Math.max(at.distanceTo(mid), r / 100)).toArray(), fov: c.fov };
      });
      if (first) fit();
      var tris = 0;
      root.traverse(function (o) {
        if (!o.isMesh) return;
        var geo = o.geometry;
        tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      });
      var prev = want; // what was chosen / playing on the model this replaces
      if (mixer) mixer.stopAllAction();
      mixer = action = null;
      clips = g.animations || [];
      rest = [];
      root.traverse(function (o) {
        rest.push({ o: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
      });
      pick = 0;
      anim = 'rest';
      if (clips.length) {
        mixer = new THREE.AnimationMixer(root);
        clips.forEach(function (c, i) {
          if (clipLabel(c, i) === prev.name) pick = i;
        });
        animState('rest');
        if (prev.playing) playClip();
      } else {
        animState('none');
      }
      el.dataset.tris = String(Math.round(tris));
      el.dataset.state = 'ready';
      report();
      base = Math.round(tris).toLocaleString() + ' tris' + (clips.length ? ' · ' + clips.length + (clips.length === 1 ? ' animation' : ' animations') : '');
      status();
      el.dispatchEvent(new Event('mv-ready'));
    }).catch(function (e) {
      if (!alive || mine !== seq) return;
      el.dataset.state = 'error';
      label(el, "Can't preview this model here (" + String((e && e.message) || e).slice(0, 80) + ') — open it in the Library.');
      el.dispatchEvent(new CustomEvent('mv-error', { detail: String((e && e.message) || e).slice(0, 120) })); // a page may say it in its own words
    });
  }
  load(url);

  (function tick() {
    raf = requestAnimationFrame(tick);
    if (mixer) mixer.update(clock.getDelta());
    if (controls.update()) report();
    renderer.render(scene, camera);
    updatePins(performance.now());
  })();

  var handle = {
    load: load,
    setCamera: setCamera,
    camera: pose,
    glbCameras: function () { return cams; },
    setMode: setMode,
    setReference: setReference,
    setReferenceVisible: setReferenceVisible,
    parts: parts,
    setVisible: setVisible,
    mode: function () { return mode; },
    clips: function () { return clips.map(function (c, i) { return { name: clipLabel(c, i), seconds: Math.round(c.duration * 100) / 100 }; }); },
    play: playClip,
    stop: stopClip,
    chooseClip: function (name) {
      clips.forEach(function (c, i) {
        if (clipLabel(c, i) === name) chooseClip(i);
      });
    },
    clipIndex: function () { return pick; },
    animation: function () { return anim; },
    pick: pickAt,
    setPreview: setPreview,
    setPins: setPins,
    viewState: viewState,
    restoreView: restoreView,
    isolate: isolate,
    showAll: showAll,
    hiddenCount: function () { return Object.keys(hidden).length; },
    dispose: function () {
      if (pinLayer && pinLayer.parentNode) pinLayer.parentNode.removeChild(pinLayer);
      pinLayer = null;
      pinList = [];
      alive = false;
      if (mixer) { // the animation state goes with the viewer: stop the actions, drop the mixer's cache of the model, take the row off
        mixer.stopAllAction();
        if (current) mixer.uncacheRoot(current);
      }
      mixer = action = null;
      clips = [];
      rest = [];
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      if (ref && ref.root) {
        scene.remove(ref.root);
        free(ref.root);
      }
      Object.keys(shared).forEach(function (k) { shared[k].dispose(); });
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
  if (opts.anim !== false) el.appendChild((overlay = animRow(handle, el)));
  return handle;
}

/* The animation controls as one row — a picker of every clip in the file, Play / Pause and Stop — wired to a viewer handle. It is
   hidden while the model has no clips, refills its picker on every 'mv-ready' and repaints on 'mv-anim', so it needs no calls from the
   caller. mount() puts one over the canvas (top left, CSS) unless opts.anim is false; a page with crowded corners (the Watch tab)
   mounts with anim:false and puts animRow(handle, box) where it has room. */
export function animRow(h, el) {
  var row = document.createElement('div');
  row.className = 'mv-anim';
  row.hidden = true;
  var sel = document.createElement('select');
  sel.className = 'mv-clip';
  sel.setAttribute('aria-label', 'Animation or pose');
  sel.addEventListener('change', function () {
    var c = h.clips()[Number(sel.value)];
    if (c) h.chooseClip(c.name);
  });
  var p = document.createElement('button');
  p.type = 'button';
  p.className = 'mv-play';
  p.addEventListener('click', function () { h.play(); });
  var x = document.createElement('button');
  x.type = 'button';
  x.className = 'mv-stop';
  x.textContent = '■';
  x.setAttribute('aria-label', 'Stop and return to the rest pose');
  x.title = 'Stop (back to the rest pose)';
  x.addEventListener('click', function () { h.stop(); });
  row.appendChild(sel);
  row.appendChild(p);
  row.appendChild(x);
  function fill() {
    var cs = h.clips();
    row.hidden = !cs.length;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    cs.forEach(function (c, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = c.name;
      sel.appendChild(o);
    });
    paint();
  }
  function paint() {
    var s = h.animation();
    sel.value = String(h.clipIndex());
    p.textContent = s === 'playing' ? '❚❚' : '▶';
    p.setAttribute('aria-label', s === 'playing' ? 'Pause animation' : 'Play animation');
    p.title = s === 'playing' ? 'Pause' : 'Play';
    x.disabled = s !== 'playing' && s !== 'paused';
  }
  el.addEventListener('mv-ready', fill);
  el.addEventListener('mv-anim', paint);
  fill();
  return row;
}
