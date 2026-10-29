"""uv_rebake — bake the old appearance onto a new UV layout: source (old UVs and materials) to the body's new UV layer, pass by pass. Saves a checkpoint.

ORDER MATTERS: do this while the body still has the source's shape. If the body was reshaped (mesh_proportion, kit2_tweak ...) after it was taken from the source, the surfaces no longer coincide and the bake misses island texels: give `reshape_source` the same anchors as the mesh_proportion that reshaped the body. Read `misses_pct_of_island_texels`.

Cycles on the CPU, "selected to active": the source object (the original mesh with its own UVs and textures, imported from a GLB, or an object already in the scene) is baked onto the body through the body's
ACTIVE UV layer (or `uv`). The old UV layer and the old material stay in the file; the body gets a NEW material that uses the baked images.
Passes: base_color (colour only, no lighting), roughness, metallic (via an emission copy of the source material), normal (tangent space, rebaked for the new UV, never copied), ao.

params:
  source_glb   path under the tool root of the source GLB (e.g. "downloads/library/<id>.glb"): imported as `bake_src` and used for the bake
  source       or the name of an object already in the scene (not the body)
  uv           the body's UV layer to bake into (default the active one)
  size         texture size px (default 2048)
  passes       list of base_color, roughness, metallic, normal, ao (default the first four)
  samples      Cycles samples per pass (default 8)
  margin_px    padding around islands (default 16)
  cage_mm      ray start offset above the body's surface (default 6); max_ray_mm farthest hit (default 30)
  reshape_source  {"anchors": [[from_mm, to_mm], ...], "full_mm": 130, "zero_mm": 200, "smooth_mm": 25}: apply the SAME height remap as mesh_proportion to the imported source before baking, so a body that was reshaped with
               those anchors still coincides with its source (otherwise the bake misses where they differ). Only with source_glb.
  miss_report  true (default): also write out/<name>-misses.png (white = an island texel no ray reached) and list the largest clusters of misses under `misses`
               (texels, UV box, centre in UV, centre on the body in world mm) with how many are single texels; `miss_clusters` how many to list (default 10). The misses are read from the base-colour pass; the normal pass uses the same rays
  name         file stem of the images in out/ (default "<job>")
  orm          true (default): also write one packed image <name>-orm.png: ao in R (white if not baked), roughness in G, metallic in B
Returns: images (file, size, colour space, pass), alignment (largest difference of the source's and the body's bounding boxes, mm), coverage (texels inside UV islands, percent of the sheet), misses (texels inside islands the bake did not reach, percent of the
island texels, for base_color), material (the new material), seconds per pass, notes.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402

PASSES = {"base_color": ("DIFFUSE", "sRGB"), "roughness": ("ROUGHNESS", "Non-Color"), "metallic": ("EMIT", "Non-Color"), "normal": ("NORMAL", "Non-Color"), "ao": ("AO", "Non-Color")}
FILL = {"base_color": (1.0, 0.0, 1.0, 1.0), "roughness": (0.5, 0.5, 0.5, 1.0), "metallic": (0.0, 0.0, 0.0, 1.0), "normal": (0.5, 0.5, 1.0, 1.0), "ao": (1.0, 1.0, 1.0, 1.0)}


def miss_report(miss, tv, P3, U, dst, size, outd, name, files, top):
    """the bake's misses as a picture (white = a texel inside an island that no ray reached; out/<name>-misses.png) and as the largest clusters: pixels, UV box, and where on the body (world mm)"""
    ys, xs = np.nonzero(miss)
    if not len(ys):
        return {"texels": 0, "clusters": []}
    img = np.repeat((miss[::-1, :, None]).astype(np.float32), 3, axis=2)
    path = os.path.join(outd, f"{name}-misses.png")
    UC.save_image(img, path, "Non-Color", "PNG")
    files.append(path)
    # 8-connected clusters (flood fill over the miss pixels only)
    idx = {(int(y), int(x)) for y, x in zip(ys, xs)}
    seen, clusters = set(), []
    for p0 in idx:
        if p0 in seen:
            continue
        seen.add(p0)
        st, pts = [p0], []
        while st:
            y, x = st.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    q = (y + dy, x + dx)
                    if q in idx and q not in seen:
                        seen.add(q)
                        st.append(q)
        clusters.append(pts)
    clusters.sort(key=len, reverse=True)
    M = np.array(dst.matrix_world)
    px = U * size
    res = []
    for pts in clusters[:top]:
        a = np.array(pts, float)
        cy, cx = a.mean(0)
        k = np.argmin(((a - [cy, cx]) ** 2).sum(1))
        py, pxx = a[k][0] + 0.5, a[k][1] + 0.5
        # the triangle holding that texel (row 0 = v 0, as raster_ids)
        A, B, C = px[:, 0], px[:, 1], px[:, 2]
        d = (B[:, 1] - C[:, 1]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - B[:, 0]) * (A[:, 1] - C[:, 1])
        ok = np.abs(d) > 1e-12
        l1 = np.where(ok, ((B[:, 1] - C[:, 1]) * (pxx - C[:, 0]) + (C[:, 0] - B[:, 0]) * (py - C[:, 1])) / np.where(ok, d, 1), -1)
        l2 = np.where(ok, ((C[:, 1] - A[:, 1]) * (pxx - C[:, 0]) + (A[:, 0] - C[:, 0]) * (py - C[:, 1])) / np.where(ok, d, 1), -1)
        inside = ok & (l1 >= -1e-6) & (l2 >= -1e-6) & (1 - l1 - l2 >= -1e-6)
        loc = None
        if inside.any():
            t = int(np.argmax(inside))
            pt = P3[t][0] * l1[t] + P3[t][1] * l2[t] + P3[t][2] * (1 - l1[t] - l2[t])
            loc = [round(float(x) * 1000, 1) for x in (M[:3, :3] @ pt + M[:3, 3])]
        res.append({"texels": len(pts), "uv_box": [round(float(a[:, 1].min()) / size, 4), round(float(1 - (a[:, 0].max() + 1) / size), 4), round(float((a[:, 1].max() + 1)) / size, 4), round(float(1 - a[:, 0].min() / size), 4)],
                    "centre_uv": [round(float(cx + 0.5) / size, 4), round(float(1 - (cy + 0.5) / size), 4)], "centre_mm": loc})
    sizes = [len(c) for c in clusters]
    return {"texels": int(len(ys)), "clusters_total": len(clusters), "single_texel_clusters": int(sum(1 for s in sizes if s == 1)), "largest_cluster_texels": sizes[0], "file": os.path.basename(path), "clusters": res}


def bbox(objs):
    v = np.concatenate([np.array([(o.matrix_world @ p.co)[:] for p in o.data.vertices]) for o in objs])
    return v.min(0), v.max(0)


def main():
    dst = bpy.data.objects.get(L.param("body", "body"))
    if dst is None or dst.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('body', 'body')}")
    me = dst.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    if uvn is None or uvn not in me.uv_layers:
        raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
    me.uv_layers.active = me.uv_layers[uvn]
    passes = L.param("passes") or ["base_color", "roughness", "metallic", "normal"]
    bad = [p for p in passes if p not in PASSES]
    if bad:
        raise RuntimeError(f"unknown pass {bad}: {', '.join(PASSES)}")
    size = int(L.param("size", 2048))
    scn = bpy.context.scene
    before = set(bpy.data.objects.keys())
    if L.param("source_glb"):
        bpy.ops.import_scene.gltf(filepath=L.resolve(L.param("source_glb"), what="source_glb"))
        new = [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]
        meshes = [o for o in new if o.type == "MESH"]
        if not meshes:
            raise RuntimeError("the source GLB has no mesh")
        for o in new:
            if o.type != "MESH":
                o.hide_render = True
        if len(meshes) > 1:
            bpy.ops.object.select_all(action="DESELECT")
            for o in meshes:
                o.select_set(True)
            bpy.context.view_layer.objects.active = meshes[0]
            bpy.ops.object.join()
        src = bpy.context.view_layer.objects.active if len(meshes) > 1 else meshes[0]
        src.name = "bake_src"
    else:
        src = bpy.data.objects.get(L.param("source") or "")
        if src is None or src.type != "MESH" or src is dst:
            raise RuntimeError("give source_glb, or source: the name of another mesh in the scene")
    rs = L.param("reshape_source")
    reshaped = None
    if rs:
        if not L.param("source_glb"):
            raise RuntimeError("reshape_source needs source_glb (it reshapes the imported source)")
        sv = np.array([(src.matrix_world @ p.co)[:] for p in src.data.vertices])
        nv = UC.remap_z(sv, rs["anchors"], rs.get("full_mm", 130), rs.get("zero_mm", 200), rs.get("smooth_mm", 25), rs.get("centre_x_mm"))
        inv = src.matrix_world.inverted()
        from mathutils import Vector
        src.data.vertices.foreach_set("co", np.array([(inv @ Vector(p))[:] for p in nv]).ravel())
        src.data.update()
        reshaped = {"max_move_mm": round(float(np.abs(nv - sv).max() * 1000), 1)}
    a0, a1 = bbox([src]), bbox([dst])
    align = max(float(np.abs(a0[0] - a1[0]).max()), float(np.abs(a0[1] - a1[1]).max())) * 1000
    notes = []
    if align > 20:
        notes.append(f"the source and the body differ by up to {align:.0f} mm in their bounding boxes: they may not be in the same place or scale; the bake will miss")
    # the new material: one image texture per pass, a Principled BSDF using them
    mat = bpy.data.materials.new(f"{dst.name}-rebaked")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out_n = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    pr = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(pr.outputs["BSDF"], out_n.inputs["Surface"])
    uvmap = nt.nodes.new("ShaderNodeUVMap")
    uvmap.uv_map = uvn
    imgs, tex = {}, {}
    for p in passes:
        im = bpy.data.images.new(f"{dst.name}-{p}", size, size, alpha=False, float_buffer=False)
        im.colorspace_settings.name = PASSES[p][1]
        px = np.tile(np.array(FILL[p], np.float32), size * size)
        im.pixels.foreach_set(px)
        imgs[p] = im
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = im
        t.interpolation = "Linear"
        nt.links.new(uvmap.outputs["UV"], t.inputs["Vector"])
        tex[p] = t
    if "base_color" in tex:
        nt.links.new(tex["base_color"].outputs["Color"], pr.inputs["Base Color"])
    if "roughness" in tex:
        nt.links.new(tex["roughness"].outputs["Color"], pr.inputs["Roughness"])
    if "metallic" in tex:
        nt.links.new(tex["metallic"].outputs["Color"], pr.inputs["Metallic"])
    if "normal" in tex:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = uvn
        nt.links.new(tex["normal"].outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], pr.inputs["Normal"])
    old_mats = list(me.materials)
    me.materials.clear()
    me.materials.append(mat)
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = int(L.param("samples", 8))
    bk = scn.render.bake
    bk.margin = int(L.param("margin_px", 16))
    bk.use_clear = False
    bk.use_selected_to_active = True
    bk.cage_extrusion = float(L.param("cage_mm", 6)) / 1000.0
    bk.max_ray_distance = float(L.param("max_ray_mm", 30)) / 1000.0
    bk.normal_space = "TANGENT"
    bk.target = "IMAGE_TEXTURES"
    bk.use_pass_direct = False
    bk.use_pass_indirect = False
    bk.use_pass_color = True
    secs = {}
    for p in passes:
        t0 = time.time()
        restore = None
        if p == "metallic":  # bake the metallic value as emission colour from a copy of the source materials
            restore = []
            for i, slot in enumerate(src.material_slots):
                m = slot.material
                if m is None or not m.use_nodes:
                    continue
                m2 = m.copy()
                P = next((n for n in m2.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                if P is None:
                    continue
                mi = P.inputs["Metallic"]
                if mi.is_linked:
                    m2.node_tree.links.new(mi.links[0].from_socket, P.inputs["Emission Color"])
                else:
                    v = mi.default_value
                    P.inputs["Emission Color"].default_value = (v, v, v, 1)
                P.inputs["Emission Strength"].default_value = 1.0
                restore.append((slot, m))
                slot.material = m2
        for n in nt.nodes:
            n.select = False
        tex[p].select = True
        nt.nodes.active = tex[p]
        bpy.ops.object.select_all(action="DESELECT")
        src.select_set(True)
        dst.select_set(True)
        bpy.context.view_layer.objects.active = dst
        kw = {"type": PASSES[p][0], "use_selected_to_active": True, "margin": bk.margin, "use_clear": False, "target": "IMAGE_TEXTURES", "normal_space": "TANGENT"}
        if p == "base_color":
            kw["pass_filter"] = {"COLOR"}
        bpy.ops.object.bake(**kw)
        for slot, m in (restore or []):
            slot.material = m
        secs[p] = round(time.time() - t0, 1)
    # coverage of the layout and the bake's misses, then the files
    tv, P, U, tl = UC.uv_arrays(me, uvn)
    cnt = UC.raster_counts(U, size)
    mask = cnt >= 1
    files, info = [], []
    outd = L.ARGS["out_dir"]
    name = L.param("name", L.ARGS["job"])
    arr = {}
    for p, im in imgs.items():
        a = np.empty(size * size * 4, np.float32)
        im.pixels.foreach_get(a)
        a = a.reshape(size, size, 4)
        arr[p] = a
        path = os.path.join(outd, f"{name}-{p}.png")
        im.filepath_raw = path
        im.file_format = "PNG"
        im.save()
        files.append(path)
        info.append({"pass": p, "file": os.path.basename(path), "size": size, "colour_space": PASSES[p][1]})
    miss, miss_info = None, None
    if "base_color" in arr:
        f = np.array(FILL["base_color"][:3])
        isf = (np.abs(arr["base_color"][..., :3] - f) < 0.02).all(-1)
        miss = round(float((isf & mask).sum() / max(mask.sum(), 1) * 100), 2)
        if L.param("miss_report", True):
            miss_info = miss_report(isf & mask, tv, P, U, dst, size, outd, name, files, int(L.param("miss_clusters", 10)))
    if L.param("orm", True) and ("roughness" in arr or "metallic" in arr):
        o = np.ones((size, size, 4), np.float32)
        if "ao" in arr:
            o[..., 0] = arr["ao"][..., 0]
        if "roughness" in arr:
            o[..., 1] = arr["roughness"][..., 0]
        if "metallic" in arr:
            o[..., 2] = arr["metallic"][..., 0]
        im = bpy.data.images.new(f"{dst.name}-orm", size, size, alpha=False)
        im.colorspace_settings.name = "Non-Color"
        im.pixels.foreach_set(o.ravel())
        path = os.path.join(outd, f"{name}-orm.png")
        im.filepath_raw = path
        im.file_format = "PNG"
        im.save()
        files.append(path)
        info.append({"pass": "orm", "file": os.path.basename(path), "size": size, "colour_space": "Non-Color"})
    L.finish({"images": info, "alignment_mm": round(align, 2), "coverage_pct": round(float(mask.mean() * 100), 1), "misses_pct_of_island_texels": miss, "misses": miss_info, "material": mat.name, "uv": uvn, "source_reshaped": reshaped, "seconds": secs,
              "kept": {"old_uv_layers": [u.name for u in me.uv_layers if u.name != uvn], "old_materials": [m.name for m in old_mats if m]}, "notes": notes}, files=files, save=True)


L.run(main)
