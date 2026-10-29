"""face_side_export — a separate INSPECTION GLB in which every geometric FRONT shows white and every BACK shows red, in any glTF viewer that culls back faces (orbit it and look for red). The scene's own objects, materials, geometry and archived objects are not changed: two new objects are added (run it on a COPY of the job, e.g. job_copy first). Saves a checkpoint of that copy (not with dry_run).

How: the "front" of a face is the side a viewer sees (the side the winding and the object's transform make visible; a MIRRORED transform is handled: its winding is corrected). The selected meshes are evaluated (modifiers applied, as exported), baked into WORLD coordinates and written as TWO meshes: `FaceSide_Front_White` with the visible winding and a white single-sided material, and `FaceSide_Back_Red` with the same triangles in REVERSED winding and a red single-sided material (both with back-face culling, glTF doubleSided false). A viewer that culls back faces then shows the white copy from the front side of a face and the red copy from its back side; nothing is offset, nothing z-fights, because from either side exactly one of the two is culled. Both materials carry a little emission (default 0.5 of their colour) so shaded sides do not go black.
params:
  objects     names / globs of the meshes (default ["*"]: every mesh in the view layer; objects outside the view layer, e.g. archived ones, are not included)
  exclude     names / globs to leave out (e.g. the huge foliage cards)
  name        file stem of the GLB in out/ (default "face-side-review")
  white / red [r, g, b] (0..1, as seen; default [1, 1, 1] / [0.9, 0.05, 0.05])
  emission    0.5: emission strength as a fraction of the colour (0 = none)
  max_tris    default 6,000,000: refuses a bigger set (narrow `objects` or `exclude`)
  views       optional list of review renders that DO enforce the culling (Cycles ignores the material's back-face culling, so these use render-only copies of the two materials in which the back-facing side is transparent): "iso" | "top" | "front" | "side" | "back" | {"name", "dir": [x, y, z]} (the direction from the model to the camera); `res` 900, `samples` 16, `view_prefix` (default the GLB name). PNGs in out/; only the two diagnostic objects render, the scene is put back as it was
  verify      true (default): reads the written GLB back and checks, for up to 40,000 sampled triangles, that the white mesh's counter-clockwise (front) normal equals the original object's visible normal and that the red mesh's is the opposite, in the exported (Y-up) frame, and that both materials are single-sided; also checks a mirrored-transform object separately when there is one
Returns: objects used / excluded, mirrored objects (determinant < 0: winding corrected), triangles, the GLB (path, bytes), and `verify`: sampled, white_agree_share, red_opposite_share, both materials' doubleSided / colour, mirrored_checked. Limits: geometry only (alpha cut-outs and transparent materials are ignored: a card shows as a solid white or red sheet); a viewer that does not cull back faces shows the white and red copies coincident (use one that does; three.js / glTF viewers and Blender's viewport with backface culling do); the GLB can be large (two copies of the selected triangles).
"""
import fnmatch
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def make_mat(name, rgb, emission):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    b.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Metallic"].default_value = 0.0
    if emission > 0:
        b.inputs["Emission Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        b.inputs["Emission Strength"].default_value = float(emission)
    m.use_backface_culling = True   # single sided: glTF doubleSided false
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return m


def build_obj(name, verts, tris, mat):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
    me.loops.add(len(tris) * 3)
    me.loops.foreach_set("vertex_index", tris.astype(np.int32).ravel())
    me.polygons.add(len(tris))
    me.polygons.foreach_set("loop_start", (np.arange(len(tris)) * 3).astype(np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(tris), 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def glb_read(path):
    with open(path, "rb") as f:
        data = f.read()
    jl = struct.unpack("<I", data[12:16])[0]
    js = json.loads(data[20:20 + jl].decode("utf-8"))
    off = 20 + jl
    bl = struct.unpack("<I", data[off:off + 4])[0]
    binb = data[off + 8:off + 8 + bl]
    return js, binb


def accessor(js, binb, idx):
    a = js["accessors"][idx]
    bv = js["bufferViews"][a["bufferView"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = a["count"]
    comp = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a["componentType"]]
    cnt = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    stride = bv.get("byteStride")
    itemsize = np.dtype(comp).itemsize * cnt
    if stride and stride != itemsize:
        arr = np.empty((n, cnt), dtype=comp)
        for i in range(n):
            arr[i] = np.frombuffer(binb, dtype=comp, count=cnt, offset=base + i * stride)
        return arr
    return np.frombuffer(binb, dtype=comp, count=n * cnt, offset=base).reshape(n, cnt)



def render_views(Vw, Tv, specs, res, samples, prefix, out_dir, white, red, emis):
    """Cycles CPU renders of the two diagnostic objects with render-only materials that emulate back-face culling (Cycles ignores the material's culling): the back-facing side is transparent. Cycles also skips a surface that lies exactly on the one it just passed through, so for the render ONLY the red copy is moved a hair (0.2 mm, at least 2e-5 of the model's size) behind the faces along their visible normals; the GLB and the saved objects are not offset. The scene is restored afterwards."""
    import math
    from mathutils import Vector
    scn = bpy.context.scene
    ow, orr = bpy.data.objects["FaceSide_Front_White"], bpy.data.objects["FaceSide_Back_Red"]
    old_mats = {ow.name: list(ow.data.materials), orr.name: list(orr.data.materials)}
    rmats = []

    def rmat(nm, rgb):
        m = bpy.data.materials.new(nm)
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        pr = nt.nodes.new("ShaderNodeBsdfPrincipled")
        pr.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1)
        pr.inputs["Roughness"].default_value = 1.0
        pr.inputs["Emission Color"].default_value = (rgb[0], rgb[1], rgb[2], 1)
        pr.inputs["Emission Strength"].default_value = max(emis, 0.35)
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        mix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(geo.outputs["Backfacing"], mix.inputs["Fac"])
        nt.links.new(pr.outputs["BSDF"], mix.inputs[1])
        nt.links.new(tr.outputs["BSDF"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        rmats.append(m)
        return m
    mw_, mr_ = rmat("FS_render_white", white), rmat("FS_render_red", red)
    ow.data.materials.clear()
    ow.data.materials.append(mw_)
    a_, b_, c_ = Vw[Tv[:, 0]], Vw[Tv[:, 1]], Vw[Tv[:, 2]]
    fn = np.cross(b_ - a_, c_ - a_)
    vn = np.zeros_like(Vw)
    for k in range(3):
        np.add.at(vn, Tv[:, k], fn)
    ln_ = np.linalg.norm(vn, axis=1)
    vn[ln_ > 0] /= ln_[ln_ > 0][:, None]
    rad0 = float(np.linalg.norm(Vw.max(axis=0) - Vw.min(axis=0))) / 2.0
    off = max(2e-4, 2e-5 * rad0)
    orr_r = build_obj("FaceSide_Back_Red_render", Vw - vn * off, Tv[:, [0, 2, 1]], mr_)
    orr.hide_render = True
    hide_before = {o.name: o.hide_render for o in bpy.context.scene.objects if o.name != orr_r.name}
    for o in bpy.context.scene.objects:
        if o.name not in (ow.name, orr_r.name):
            o.hide_render = True
    eng0, rx0, ry0, rp0, sm0 = scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, getattr(scn.cycles, "samples", 16)
    cam0, world0 = scn.camera, scn.world
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(samples)
    scn.cycles.use_denoising = False
    scn.cycles.transparent_max_bounces = 16
    scn.render.resolution_x = scn.render.resolution_y = int(res)
    scn.render.resolution_percentage = 100
    w = bpy.data.worlds.new("FS_world")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.57, 0.6, 1)
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scn.world = w
    cam_d = bpy.data.cameras.new("FS_cam")
    cam = bpy.data.objects.new("FS_cam", cam_d)
    scn.collection.objects.link(cam)
    scn.camera = cam
    lo, hi = Vw.min(axis=0), Vw.max(axis=0)
    ctr = Vector(((lo + hi) / 2).tolist())
    rad = float(np.linalg.norm(hi - lo)) / 2.0
    files = []
    named = {"iso": (1, -1, 0.8), "top": (0, 0.0001, 1), "front": (0, -1, 0.15), "back": (0, 1, 0.15), "side": (1, 0, 0.15)}
    try:
        for sp in specs:
            nm = sp if isinstance(sp, str) else sp.get("name", "view")
            d = Vector(named[sp]) if isinstance(sp, str) else Vector(sp["dir"])
            d.normalize()
            cam_d.lens = 50
            cam_d.sensor_width = 36
            dist = rad / math.tan(math.atan(18.0 / 50.0)) * 1.05
            cam.location = ctr + d * dist
            cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
            fp = os.path.join(out_dir, f"{prefix}-{nm}.png")
            scn.render.filepath = fp
            scn.render.image_settings.file_format = "PNG"
            bpy.ops.render.render(write_still=True)
            files.append(os.path.basename(fp))
    finally:
        scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = eng0, rx0, ry0, rp0
        scn.camera, scn.world = cam0, world0
        for o in bpy.context.scene.objects:
            if o.name in hide_before:
                o.hide_render = hide_before[o.name]
        scn.collection.objects.unlink(cam)
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_d)
        bpy.data.worlds.remove(w)
        ob = bpy.data.objects[ow.name]
        ob.data.materials.clear()
        for m in old_mats[ow.name]:
            ob.data.materials.append(m)
        orr.hide_render = False
        me_r = orr_r.data
        bpy.data.objects.remove(orr_r, do_unlink=True)
        bpy.data.meshes.remove(me_r)
        for m in rmats:
            bpy.data.materials.remove(m)
    return files


def main():
    pats = L.param("objects") or ["*"]
    if isinstance(pats, str):
        pats = [pats]
    excl = L.param("exclude") or []
    if isinstance(excl, str):
        excl = [excl]
    name = str(L.param("name", "face-side-review"))
    white = L.param("white", [1.0, 1.0, 1.0])
    red = L.param("red", [0.9, 0.05, 0.05])
    emis = float(L.param("emission", 0.5))
    max_tris = int(L.param("max_tris", 6_000_000))
    dry = bool(L.param("dry_run", False))
    vl = bpy.context.view_layer
    dg = bpy.context.evaluated_depsgraph_get()
    sel = [o for o in vl.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in pats) and not any(fnmatch.fnmatchcase(o.name, g) for g in excl)]
    if not sel:
        raise RuntimeError(f"no mesh matches {pats}")
    V, T = [], []
    base = 0
    mirrored = []
    ntri = 0
    per_obj = []
    for o in sel:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            nt = len(me.loop_triangles)
            if nt == 0:
                continue
            mw = np.array(ev.matrix_world)
            det = float(np.linalg.det(mw[:3, :3]))
            nv = len(me.vertices)
            co = np.empty(nv * 3)
            me.vertices.foreach_get("co", co)
            w = (mw[:3, :3] @ co.reshape(-1, 3).T).T + mw[:3, 3]
            tv = np.empty(nt * 3, dtype=np.int64)
            me.loop_triangles.foreach_get("vertices", tv)
            tv = tv.reshape(-1, 3)
            if det < 0:
                tv = tv[:, [0, 2, 1]]   # a mirrored transform reverses what the stored winding shows: the VISIBLE winding is the reverse
                mirrored.append(o.name)
            V.append(w)
            T.append(tv + base)
            base += nv
            ntri += nt
            per_obj.append((o.name, nt, det < 0))
            if ntri > max_tris:
                raise RuntimeError(f"{ntri} triangles so far (max_tris {max_tris}): narrow `objects` or add `exclude`")
        finally:
            ev.to_mesh_clear()
    Vw = np.vstack(V)
    Tv = np.vstack(T)
    tri_obj = np.concatenate([np.full(nt_, oi_, dtype=np.int32) for oi_, (_n, nt_, _m) in enumerate(per_obj)])
    if dry:
        L.finish({"dry_run": True, "objects": len(per_obj), "triangles": int(len(Tv)), "mirrored_objects": mirrored[:50]}, save=False)
        return
    mw_ = make_mat("FaceSide_White", white, emis)
    mr_ = make_mat("FaceSide_Red", red, emis)
    ow = build_obj("FaceSide_Front_White", Vw, Tv, mw_)
    orr = build_obj("FaceSide_Back_Red", Vw, Tv[:, [0, 2, 1]], mr_)
    for o in vl.objects:
        o.select_set(False)
    ow.select_set(True)
    orr.select_set(True)
    out_dir = L.ARGS["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_yup=True, export_normals=True, export_texcoords=False, export_materials="EXPORT")
    rep = {"objects": len(per_obj), "excluded_patterns": excl, "mirrored_objects": mirrored[:50], "mirrored_count": len(mirrored), "triangles": int(len(Tv)), "glb": os.path.basename(path), "glb_bytes": os.path.getsize(path)}
    if L.param("verify", True):
        js, binb = glb_read(path)
        mats = {m.get("name"): m for m in js.get("materials", [])}
        rep["verify"] = {"materials": {k: {"doubleSided": bool(v.get("doubleSided", False)), "baseColorFactor": v.get("pbrMetallicRoughness", {}).get("baseColorFactor"), "emissiveFactor": v.get("emissiveFactor")} for k, v in mats.items()}}
        def yup(a):   # the exported (Y-up) frame: (x, z, -y)
            return np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)
        a, b, c = Vw[Tv[:, 0]], Vw[Tv[:, 1]], Vw[Tv[:, 2]]
        nrm = np.cross(b - a, c - a)
        ln = np.linalg.norm(nrm, axis=1)
        okt = ln > 1e-14
        nrm = nrm[okt] / ln[okt][:, None]
        cen = yup(((a + b + c) / 3.0)[okt])
        nrm_y = yup(nrm)

        _dt = np.dtype([("x", np.int64), ("y", np.int64), ("z", np.int64)])

        def hkey(c3):   # exact integer triple at 1e-4 (structured, so no hash collisions)
            q = np.round(c3 * 1e4).astype(np.int64)
            out = np.empty(len(q), dtype=_dt)
            out["x"], out["y"], out["z"] = q[:, 0], q[:, 1], q[:, 2]
            return out
        ko = hkey(cen)
        obj_of = tri_obj[okt]
        order = np.argsort(ko)
        ko_s = ko[order]
        # AMBIGUOUS keys: several original triangles with the same centroid (coincident triangles of different objects or back-to-back sheets); if their normals differ the centroid cannot say which one a GLB triangle came from, so those are counted apart, not as agreement or disagreement
        uk, first, cnt = np.unique(ko_s, return_index=True, return_counts=True)
        amb = np.zeros(len(ko_s), dtype=bool)
        amb_pairs = []
        for u_i in np.nonzero(cnt > 1)[0]:
            grp = order[first[u_i]:first[u_i] + cnt[u_i]]
            ns = nrm_y[grp]
            if (ns @ ns[0] < 0.5).any():
                amb[first[u_i]:first[u_i] + cnt[u_i]] = True
                if len(amb_pairs) < 10:
                    amb_pairs.append({"objects": sorted({per_obj[int(obj_of[g])][0] for g in grp})[:4], "centroid_yup": [round(float(x), 4) for x in cen[grp[0]]], "normals": [[round(float(x), 3) for x in ns[k_]] for k_ in range(min(3, len(ns)))]})
        res = {}
        dis = []
        for node_name, want_sign in (("FaceSide_Front_White", 1.0), ("FaceSide_Back_Red", -1.0)):
            nd = next((n for n in js["nodes"] if n.get("name") == node_name), None)
            if nd is None or "mesh" not in nd:
                res[node_name] = {"error": "node not in the GLB"}
                continue
            agree = tot = tri_total = ambiguous = 0
            for pr in js["meshes"][nd["mesh"]]["primitives"]:
                pos = accessor(js, binb, pr["attributes"]["POSITION"]).astype(np.float64)
                idx = accessor(js, binb, pr["indices"]).reshape(-1, 3).astype(np.int64) if "indices" in pr else np.arange(len(pos)).reshape(-1, 3)
                tri_total += len(idx)
                if len(idx) > 40000:
                    idx = idx[np.random.default_rng(1).choice(len(idx), 40000, replace=False)]
                p0, p1, p2 = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
                ng = np.cross(p1 - p0, p2 - p0)
                lg = np.linalg.norm(ng, axis=1)
                good = lg > 1e-14
                ng = ng[good] / lg[good][:, None]
                cg = ((p0 + p1 + p2) / 3.0)[good]
                kg = hkey(cg)
                pos_i = np.clip(np.searchsorted(ko_s, kg), 0, len(ko_s) - 1)
                hit = ko_s[pos_i] == kg
                a_hit = amb[pos_i[hit]]
                ambiguous += int(a_hit.sum())
                oi = order[pos_i[hit]][~a_hit]
                dots = (ng[hit][~a_hit] * nrm_y[oi]).sum(axis=1) * want_sign
                tot += int(len(dots))
                agree += int((dots > 0.5).sum())
                bad_i = np.nonzero(dots <= 0.5)[0]
                for bi in bad_i[:5]:
                    dis.append({"node": node_name, "object": per_obj[int(obj_of[oi[bi]])][0], "centroid_yup": [round(float(x), 4) for x in cg[hit][~a_hit][bi]], "dot": round(float(dots[bi]), 3)})
            res[node_name] = {"triangles_in_glb": int(tri_total), "sampled_unambiguous": int(tot), "sampled_ambiguous_not_judged": int(ambiguous), "agree_share": round(agree / max(1, tot), 5), "disagree": int(tot - agree)}
        rep["verify"]["sides"] = res
        rep["verify"]["disagreements_examples"] = dis[:8]
        rep["verify"]["ambiguous_centroid_groups"] = {"groups": int((cnt > 1).sum()) and int(sum(1 for u_i in np.nonzero(cnt > 1)[0] if amb[first[u_i]])), "examples": amb_pairs}
        rep["verify"]["note"] = "white: the counter-clockwise normal of the GLB triangle equals the original visible normal; red: it is the opposite; matched by triangle centroid (1e-4) in the exported Y-up frame"
    vs = L.param("views")
    if vs:
        rep["views"] = render_views(Vw, Tv, vs, int(L.param("res", 900)), int(L.param("samples", 16)), str(L.param("view_prefix", name)), out_dir, white, red, emis)
        rep["views_note"] = "Cycles ignores material back-face culling, so these renders use render-only copies of the two materials in which the back-facing side is transparent (the GLB and the saved materials are the culling ones)"
    L.finish(rep, save=True)


L.run(main)
