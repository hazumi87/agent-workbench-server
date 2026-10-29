"""watch_capture — render the watch frames and the light preview model of ONE checkpoint, for the live panel.

Not a verb: scripts/watch.mjs runs it (detached) after a verb has saved a checkpoint. It never saves the checkpoint.
Every camera is rendered in the four modes of kit2_modes.py (plain, color = A, wire = B, refwire = C). In `plain` the reference is hidden
and the body and every current part are shown (the reference alone if nothing else is in the scene yet: the opening shot).
Textures are swapped for downscaled copies kept in a cache (by content hash), so the big originals are never decoded twice.

params (from watch.mjs):
  live_dir   <share>/rooms/<room>/model-studio-live/<job>   (frames/<camera>/<n>.jpg and model/latest.glb are written here)
  cache_dir  folder for the downscaled textures
  n          step number
  cameras    [{id, position:[x,y,z], target:[x,y,z], fov}]   the cameras to render (Blender world: metres, Z up); ALL of them are
             also exported as camera nodes (named by id) into the preview model
  glb_cameras  the full list to export into the model (default: cameras)
  engine     "workbench" (default: OpenGL, about a second) | "cycles" (CPU, much slower, closer to the final look) | "eevee"
  samples    cycles samples (default 12) / eevee samples
  tex        texture size px for frames and model (default 1024)
  res        frame size px (default 768)
  model      true = also write the light preview model (default true)
  modes      list of mode ids to render (default: all four; other engines than workbench render plain only)
  wire_alpha opacity of the reference in mode `wire` (default 0.5)
  agent      [png path]: the operator's latest close-up; filed as frames/agent/plain/<n>.jpg (not composited)
  agent_wide [png path]: the zoomed-out picture of the same thing; filed as frames/agent-wide/plain/<n>.jpg
"""
import json
import math
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_modes as M  # noqa: E402
import kit2_cams as C  # noqa: E402



def make_cameras(cams):
    """one perspective camera object per camera, named by its id, square frame, looking from `position` at `target` (Z up)."""
    scn = bpy.context.scene
    out = {}
    for c in cams:
        data = bpy.data.cameras.new(c["id"])
        data.type = "PERSP"
        data.sensor_fit = "AUTO"
        data.angle = math.radians(float(c["fov"]))
        data.clip_start, data.clip_end = 0.02, 60
        o = bpy.data.objects.new(c["id"], data)
        pos, tgt = Vector(c["position"]), Vector(c["target"])
        o.location = pos
        o.rotation_euler = (tgt - pos).normalized().to_track_quat("-Z", "Y").to_euler()
        scn.collection.objects.link(o)
        out[c["id"]] = o
    return out


def export_model(objs, cam_objs, live_dir):
    d = os.path.join(live_dir, "model")
    os.makedirs(d, exist_ok=True)
    tmp, final = os.path.join(d, "latest.tmp.glb"), os.path.join(d, "latest.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in list(objs) + list(cam_objs):
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=tmp, export_format="GLB", use_selection=True, export_yup=True, export_cameras=True)
    os.replace(tmp, final)
    return tmp, final


def export_reference(ref, live, budget, grid_voxel=0.012):
    """model/reference.glb, written once per job: node `ref` (the reference, its colour texture, reduced to about `budget` triangles) and node `ref-grid`
    (the voxel grid of view C as EDGES ONLY: glTF lines, no faces). Same space and scale as latest.glb. No cameras."""
    import bmesh
    scn = bpy.context.scene
    tris = L.tris(ref)
    ref.name = "ref_src"
    solid = ref.copy()
    solid.data = ref.data.copy()
    solid.name = "ref"
    scn.collection.objects.link(solid)
    if tris > budget:
        dm = solid.modifiers.new("decimate", "DECIMATE")
        dm.ratio = budget / tris
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(solid.evaluated_get(dg))
    solid.modifiers.clear()
    bm0 = bmesh.new()
    bm0.from_mesh(me)
    loose = [e for e in bm0.edges if not e.link_faces]  # stray edges would export as lines (use_mesh_edges is on for the grid)
    if loose:
        bmesh.ops.delete(bm0, geom=loose, context="EDGES")
        bm0.to_mesh(me)
    bm0.free()
    solid.data = me
    grid = ref.copy()
    grid.data = ref.data.copy()
    grid.name = "ref-grid"
    scn.collection.objects.link(grid)
    md = grid.modifiers.new("remesh", "REMESH")
    md.mode, md.voxel_size = "VOXEL", grid_voxel
    dg = bpy.context.evaluated_depsgraph_get()
    gm = bpy.data.meshes.new_from_object(grid.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(gm)
    bmesh.ops.delete(bm, geom=list(bm.faces), context="FACES_ONLY")
    bm.to_mesh(gm)
    bm.free()
    gm.materials.clear()
    gmat = bpy.data.materials.new("ref-grid")
    gmat.diffuse_color = (0.3, 0.8, 1.0, 1)
    gm.materials.append(gmat)  # the exporter takes the line material from the first slot
    grid.modifiers.clear()
    grid.data = gm
    for o in (ref,):
        o.hide_render = True
    solid.hide_render = grid.hide_render = False
    d = os.path.join(live, "model")
    os.makedirs(d, exist_ok=True)
    tmp, final = os.path.join(d, "reference.tmp.glb"), os.path.join(d, "reference.glb")
    bpy.ops.object.select_all(action="DESELECT")
    solid.select_set(True)
    grid.select_set(True)
    bpy.context.view_layer.objects.active = solid
    bpy.ops.export_scene.gltf(filepath=tmp, export_format="GLB", use_selection=True, export_yup=True, export_cameras=False, export_image_format="AUTO", use_mesh_edges=True)
    os.replace(tmp, final)
    with open(final, "rb") as f:
        f.read(12)
        n, _ = struct.unpack("<I4s", f.read(8))
        j = json.loads(f.read(n))
    modes = {}
    for m in j.get("meshes", []):
        for pr in m["primitives"]:
            modes.setdefault(m.get("name"), []).append(pr.get("mode", 4))
    return {"bytes": os.path.getsize(final), "nodes": [nd.get("name") for nd in j.get("nodes", [])], "primitive_modes": modes,
            "ref_tris": L.tris(solid), "ref_tris_source": tris, "grid_edges": len(gm.edges)}


def _quat_rot(q, v):
    x, y, z, w = q
    u = np.array([x, y, z])
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def check_glb(path, cams):
    """read the camera nodes back out of the GLB (glTF space: Y up, -Z forward) and compare them with the poses in the manifest
    (position_gltf = [x, z, -y], same for the target; the camera looks along -Z of its node). Returns the worst errors."""
    with open(path, "rb") as f:
        f.read(12)
        clen, _ = struct.unpack("<I4s", f.read(8))
        j = json.loads(f.read(clen))
    nodes = j.get("nodes", [])
    parent = {}
    for i, nd in enumerate(nodes):
        for ch in nd.get("children", []):
            parent[ch] = i

    def world(i):
        nd = nodes[i]
        t = np.array(nd.get("translation", [0, 0, 0]), dtype=float)
        q = nd.get("rotation", [0, 0, 0, 1])
        s = np.array(nd.get("scale", [1, 1, 1]), dtype=float)
        if i in parent:
            pt, pq, ps = world(parent[i])
            t = pt + _quat_rot(pq, t * ps)
            # compose rotations: q_parent * q_child
            x1, y1, z1, w1 = pq
            x2, y2, z2, w2 = q
            q = [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2]
            s = s * ps
        return t, q, s

    by_name = {nd.get("name"): i for i, nd in enumerate(nodes) if "camera" in nd}
    res = {"cameras_in_glb": len(by_name), "missing": [], "max_position_error_mm": 0.0, "max_direction_error_deg": 0.0, "max_fov_error_deg": 0.0}
    for c in cams:
        i = by_name.get(c["id"])
        if i is None:
            res["missing"].append(c["id"])
            continue
        t, q, _ = world(i)
        pos = np.array([c["position"][0], c["position"][2], -c["position"][1]])
        tgt = np.array([c["target"][0], c["target"][2], -c["target"][1]])
        want = (tgt - pos) / np.linalg.norm(tgt - pos)
        got = _quat_rot(q, np.array([0.0, 0.0, -1.0]))
        got = got / np.linalg.norm(got)
        res["max_position_error_mm"] = max(res["max_position_error_mm"], round(float(np.linalg.norm(t - pos)) * 1000, 3))
        res["max_direction_error_deg"] = max(res["max_direction_error_deg"], round(math.degrees(math.acos(max(-1.0, min(1.0, float(want @ got))))), 4))
        yfov = j["cameras"][nodes[i]["camera"]]["perspective"]["yfov"]
        res["max_fov_error_deg"] = max(res["max_fov_error_deg"], round(abs(math.degrees(yfov) - float(c["fov"])), 4))
    return res


def setup_render(engine, res, samples):
    scn = bpy.context.scene
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = "JPEG"
    scn.render.image_settings.quality = 82
    scn.render.use_file_extension = False
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.30, 0.31, 0.34, 1)
    bg.inputs[1].default_value = 1.0
    scn.world.color = (0.30, 0.31, 0.34)
    if engine == "cycles":
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = samples
        scn.cycles.use_denoising = True
        scn.cycles.max_bounces = 4
        scn.render.use_persistent_data = True
    elif engine == "eevee":
        scn.render.engine = "BLENDER_EEVEE_NEXT"
        scn.eevee.taa_render_samples = samples
    else:
        M.workbench(scn, res)
    key = bpy.data.objects.new("Key", bpy.data.lights.new("Key", "SUN"))
    key.data.energy = 3.2
    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", "SUN"))
    fill.data.energy = 1.1
    for o in (key, fill):
        scn.collection.objects.link(o)
    return scn, key, fill


def agent_pic(png, out_path, w=768):
    """one of the operator's pictures as a JPEG, `w` px wide (as is, never composited)."""
    im = bpy.data.images.load(png)
    iw, ih = im.size
    if iw > w:
        im.scale(w, max(1, round(ih * w / iw)))
    im.filepath_raw = out_path
    im.file_format = "JPEG"
    im.save()


def file_agent(rep, live, n):
    for cid, key_ in (("agent", "agent"), ("agent-wide", "agent_wide")):
        pngs = [p for p in (L.param(key_) or []) if os.path.isfile(p)]
        if pngs:
            try:
                folder = os.path.join(live, "frames", cid, "plain")
                os.makedirs(folder, exist_ok=True)
                agent_pic(pngs[-1], os.path.join(folder, f"{n}.jpg"))
                rep["frames"][cid] = {"plain": f"frames/{cid}/plain/{n}.jpg"}
            except Exception as e:  # noqa: BLE001
                rep["errors"].append(f"{cid}: {type(e).__name__}: {e}")


def main():
    t0 = time.time()
    n = int(L.param("n"))
    live = L.param("live_dir")
    if L.param("agent_only"):  # the operator's own view, filed into an existing step: no checkpoint is opened
        rep = {"n": n, "frames": {}, "errors": [], "timing_s": {}, "agent_only": True, "looks": []}
        file_agent(rep, live, n)
        stamp = int(time.time() * 1000)
        for i, lk in enumerate(L.param("looks") or []):
            try:
                folder = os.path.join(live, "looks", str(n))
                os.makedirs(folder, exist_ok=True)
                base = f"{lk['label']}-{stamp}"
                agent_pic(lk["src"], os.path.join(folder, f"{base}.jpg"), w=int(lk.get("maxw", 768)))
                ent = {"file": f"looks/{n}/{base}.jpg", "wide": None, "label": lk["label"]}
                if lk.get("wide") and os.path.isfile(lk["wide"]):
                    agent_pic(lk["wide"], os.path.join(folder, f"{base}-wide.jpg"))
                    ent["wide"] = f"looks/{n}/{base}-wide.jpg"
                rep["looks"].append(ent)
            except Exception as e:  # noqa: BLE001
                rep["errors"].append(f"look {lk.get('label')}: {type(e).__name__}: {e}")
        rep["timing_s"]["total_in_blender"] = round(time.time() - t0, 2)
        L.finish(rep, save=False)
        return
    tex = int(L.param("tex", 1024))
    res = int(L.param("res", 768))
    engine = L.param("engine", "workbench")
    rep = {"n": n, "engine": engine, "frames": {}, "errors": [], "timing_s": {}}
    scn0 = bpy.context.scene
    ms = L.meshes()
    ref, assets = M.split(ms)
    shown = assets or ms  # the reference alone while nothing else is in the scene: the opening shot
    rep["objects"] = [o.name for o in shown]
    rep["opening"] = not assets
    for o in scn0.objects:
        o.hide_render = o not in shown
    try:
        t = time.time()
        rep["textures"] = M.swap_textures(shown + ([ref] if ref and assets else []), L.param("cache_dir"), tex)
        rep["timing_s"]["textures"] = round(time.time() - t, 2)
    except Exception as e:  # noqa: BLE001 - the capture must never fail the job
        rep["errors"].append(f"textures: {type(e).__name__}: {e}")
    scn0.render.resolution_x = scn0.render.resolution_y = res  # the exporter derives yfov from the frame's aspect: square
    scn0.render.resolution_percentage = 100
    cams = L.param("cameras") or []
    all_cams = L.param("glb_cameras") or cams
    if ref is not None:  # feet cameras placed from this character's own measurements
        try:
            der = C.derived(ref)
            all_cams = C.apply_to_cams([dict(c) for c in all_cams], der)
            cams = C.apply_to_cams([dict(c) for c in cams], der)
            rep["derived_cameras"] = [{"id": k, "position": v["position"], "target": v["target"], "fov": v["fov"]} for k, v in der.items()]
        except Exception as e:  # noqa: BLE001
            rep["errors"].append(f"derived cameras: {type(e).__name__}: {e}")
    union = {c["id"]: c for c in list(all_cams) + list(cams)}
    cam_objs = make_cameras(list(union.values()))
    if L.param("model", True):
        try:
            t = time.time()
            tmp, final = export_model(shown, [cam_objs[c["id"]] for c in all_cams], live)
            rep["model_bytes"] = os.path.getsize(final)
            rep["pose_check"] = check_glb(final, all_cams)
            rep["timing_s"]["model"] = round(time.time() - t, 2)
        except Exception as e:  # noqa: BLE001
            rep["errors"].append(f"model: {type(e).__name__}: {e}")
    if L.param("reference") and ref is not None:
        try:
            t = time.time()
            rep["reference"] = export_reference(ref, live, int(L.param("ref_tris", 125000)))
            rep["timing_s"]["reference"] = round(time.time() - t, 2)
        except Exception as e:  # noqa: BLE001
            rep["errors"].append(f"reference: {type(e).__name__}: {e}")
        ref = next((o for o in bpy.data.objects if o.name == "ref_src"), ref)
        ref.name = "ref"
        for o in bpy.data.objects:
            if o.name in ("ref-grid",) or (o.name == "ref" and o is not ref):
                bpy.data.objects.remove(o, do_unlink=True)
        shown = [o for o in shown if o.name != "ref_src"] or shown
    if engine != "workbench":
        M.strip_normals(shown)  # views show the true geometry (Workbench never uses normal maps); the model above kept them
    t = time.time()
    if cams:
        try:
            scn, key, fill = setup_render(engine, res, int(L.param("samples", 12)))
            modes = [M.norm(m) for m in (L.param("modes") or M.IDS)] if engine == "workbench" else ["plain"]
            rig = M.Rig(ref, assets, wire_alpha=float(L.param("wire_alpha", 0.5)))
            for mode in modes:
                tm = time.time()
                try:
                    rig.apply(mode)
                except Exception as e:  # noqa: BLE001
                    rep["errors"].append(f"mode {mode}: {type(e).__name__}: {e}")
                    continue
                rep["timing_s"][f"prep_{mode}"] = round(time.time() - tm, 2)
                tm = time.time()
                for c in cams:
                    try:
                        scn.camera = cam_objs[c["id"]]
                        d = (Vector(c["position"]) - Vector(c["target"])).normalized()  # from the subject toward the camera
                        key.rotation_euler = (-(d + Vector((0.3, 0, 0.6))).normalized()).to_track_quat("-Z", "Y").to_euler()
                        fill.rotation_euler = (-(Vector((-d.x * 0.6, -d.y * 0.6, 0.5))).normalized()).to_track_quat("-Z", "Y").to_euler()
                        folder = os.path.join(live, "frames", c["id"], mode)
                        os.makedirs(folder, exist_ok=True)
                        scn.render.filepath = os.path.join(folder, f"{n}.jpg")
                        bpy.ops.render.render(write_still=True)
                        rep["frames"].setdefault(c["id"], {})[mode] = f"frames/{c['id']}/{mode}/{n}.jpg"
                    except Exception as e:  # noqa: BLE001
                        rep["errors"].append(f"frame {c.get('id')} {mode}: {type(e).__name__}: {e}")
                rep["timing_s"][f"render_{mode}"] = round(time.time() - tm, 2)
            rep["wire_prep_s"] = rig.prep_s
        except Exception as e:  # noqa: BLE001
            rep["errors"].append(f"render setup: {type(e).__name__}: {e}")
    rep["timing_s"]["frames"] = round(time.time() - t, 2)
    file_agent(rep, live, n)
    rep["timing_s"]["total_in_blender"] = round(time.time() - t0, 2)
    L.finish(rep, save=False)


L.run(main)