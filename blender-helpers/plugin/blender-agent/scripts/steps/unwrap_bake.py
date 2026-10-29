"""unwrap_bake — reduce a dense textured part to a triangle budget, give it a clean new UV layout and bake the dense part's appearance onto it in ONE bake at the end: albedo, normal, ORM. Saves a checkpoint (not with dry_run).

The dense part is only read. The result is a NEW object `name` (default `<part>_lo`) with one new UV layer `UV_lo` and one new material `<name>-baked`; the dense part stays in the scene, hidden (`replace` true deletes it from the scene instead; the earlier checkpoint still has it).
Steps: duplicate and collapse-decimate to `budget` triangles; unwrap (`method` "smart": smart project, "seams": seams on edges sharper than `seam_deg`, then angle-based unwrap); equalise the island scale so texel density is even (`equalise`); pack; then bake the dense part onto the result through UV_lo with Cycles on the CPU ("selected to active"): albedo (colour only, no lighting), normal (tangent space, for the new UVs, geometry difference + the dense part's own normal map), and ORM (R = ambient occlusion, G = roughness, B = metallic: the glTF packing; the material reads G and B). The dense part's old UVs and textures are not used by the result.
The images are written to out/<name>-albedo.png, -normal.png, -orm.png and packed into the file.

params:
  part         the dense mesh (default: the job's only mesh)
  budget       triangles of the result (default 20000)
  tex          texture size px (default 2048)
  maps         any of "albedo", "normal", "orm" (default all three)
  method       "smart" (default) | "seams"; angle_limit_deg 66 (smart), seam_deg 60 (seams), island_margin 0.004 (fraction of the sheet), rotate true
  drop_pieces_under_tris  remove loose pieces of the reduced mesh smaller than this many triangles before unwrapping (default 0 = none; the dense part is never touched). The report says how many pieces, triangles and what share of the surface area went, lists the 25 largest (triangles, area mm2, centre mm, size mm) and writes pictures unwrapbake-dropped-front/back/top.png of the reduced mesh with those pieces in red
  equalise     true (default): the same texel density on every island before packing (then the packed sheet is scaled as a whole)
  samples      Cycles samples per pass (default 8); margin_px 16; cage_mm and max_ray_mm: ray start offset above the new surface and farthest hit (default 1.5 % and 5 % of the part's largest size)
  name         the result object and file stem (default <part>_lo)
  replace      true: remove the dense part from the scene afterwards (default false: kept, hidden)
  views        checker pictures of the result: "front", "back", "left", "right", "top", "three_quarter" (default ["front", "back"]); res px (default 768)
  dry_run      true: only reduce and unwrap (no bake, nothing saved), so the island count, stretch and checker pictures can be judged first
Returns: tris before / after, the decimate ratio, islands (count, largest and smallest share), stretch (median / p95 / max; 1 = no distortion), coverage and overlap of the sheet, density spread, the bake's misses (% of the island texels no ray reached), images, material, seconds, notes. Pictures: unwrapbake-layout.png, unwrapbake-checker-<view>.png (a colour grid on the result).
"""
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402
import kit2_modes as M  # noqa: E402
import uv_common as UC  # noqa: E402

PASSES = {"albedo": ("DIFFUSE", "sRGB"), "normal": ("NORMAL", "Non-Color"), "roughness": ("ROUGHNESS", "Non-Color"), "metallic": ("EMIT", "Non-Color"), "ao": ("AO", "Non-Color")}
FILL = {"albedo": (1.0, 0.0, 1.0, 1.0), "normal": (0.5, 0.5, 1.0, 1.0), "roughness": (0.5, 0.5, 0.5, 1.0), "metallic": (0.0, 0.0, 0.0, 1.0), "ao": (1.0, 1.0, 1.0, 1.0)}
DIRS = {"front": (0, -1, 0), "back": (0, 1, 0), "left": (1, 0, 0), "right": (-1, 0, 0), "top": (0, 0, 1), "three_quarter": (0.6, -0.8, 0.35)}


def wquant(x, w, q):
    o = np.argsort(x)
    c = np.cumsum(w[o])
    return float(x[o][np.searchsorted(c, q * c[-1])])


def components(me):
    """connected pieces of the mesh (polygons sharing a vertex) and the share of triangles in the largest 10"""
    parent = list(range(len(me.vertices)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for p in me.polygons:
        vs = p.vertices
        r0 = find(vs[0])
        for v in vs[1:]:
            r = find(v)
            if r != r0:
                parent[r] = r0
    cnt = {}
    for p in me.polygons:
        r = find(p.vertices[0])
        cnt[r] = cnt.get(r, 0) + len(p.vertices) - 2
    tot = sum(cnt.values())
    big = sorted(cnt.values(), reverse=True)
    return {"count": len(cnt), "tiny_under_20_tris": int(sum(1 for c in big if c < 20)), "largest_10_share_pct": round(100.0 * sum(big[:10]) / max(tot, 1), 1)}


def uv_stats(o, lay, size=1024):
    me = o.data
    tv, P, U, tl = UC.uv_arrays(me, lay)
    a3, a2, st = UC.tri_stretch(P, U)
    ok = np.isfinite(st) & (a3 > 1e-12)
    w = a3[ok]
    lab, n = UC.islands(me, lay)
    pt = np.array([me.loop_triangles[i].polygon_index for i in range(len(me.loop_triangles))])
    tri_isl = lab[pt]
    uvarea = np.bincount(tri_isl, weights=a2, minlength=n)
    cnt = UC.raster_counts(U, size)
    dens = np.sqrt(a2[ok] / a3[ok])
    dn = dens / max(float(np.median(dens)), 1e-12)
    outside = float(a2[((U < -0.001) | (U > 1.001)).any(axis=(1, 2))].sum() / max(a2.sum(), 1e-12) * 100)
    return {"mesh_pieces": components(me), "islands": {"count": int(n), "largest_share_pct": round(float(uvarea.max() / uvarea.sum() * 100), 1), "smallest_share_pct": round(float(uvarea.min() / uvarea.sum() * 100), 3)},
            "stretch": {"median": round(wquant(st[ok], w, 0.5), 3), "p95": round(wquant(st[ok], w, 0.95), 3), "max": round(float(st[ok].max()), 2)},
            "coverage_pct": round(float((cnt >= 1).mean() * 100), 1), "overlap_pct": round(float((cnt >= 2).mean() * 100), 2), "outside_pct": round(outside, 2),
            "density": {"p5": round(wquant(dn, w, 0.05), 3), "p50": round(wquant(dn, w, 0.5), 3), "p95": round(wquant(dn, w, 0.95), 3)}}, (tv, P, U, tl, tri_isl, cnt)


def main():
    scn = bpy.context.scene
    src = bpy.data.objects.get(L.param("part") or "") if L.param("part") else L.the_mesh()
    if src is None or src.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('part')}")
    name = L.param("name", f"{src.name}_lo")
    if bpy.data.objects.get(name) is not None:
        raise RuntimeError(f"an object named {name} exists: give another `name` (nothing is replaced)")
    budget = int(L.param("budget", 20000))
    size = int(L.param("tex", 2048))
    maps = L.param("maps") or ["albedo", "normal", "orm"]
    bad = [m for m in maps if m not in ("albedo", "normal", "orm")]
    if bad:
        raise RuntimeError(f"unknown map {bad}: albedo, normal, orm")
    dry = bool(L.param("dry_run", False))
    notes = []
    t_all = time.time()
    before = L.tris(src)

    # ---- reduce
    lo = src.copy()
    lo.data = src.data.copy()
    lo.name = name
    lo.data.name = name
    scn.collection.objects.link(lo)
    for ly in list(lo.data.uv_layers):
        lo.data.uv_layers.remove(ly)
    lo.data.materials.clear()
    lo.animation_data_clear()
    for m in list(lo.modifiers):
        lo.modifiers.remove(m)
    t0 = time.time()
    if before > budget:
        L.activate(lo)
        mod = lo.modifiers.new("Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = budget / before
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    else:
        notes.append(f"the part has {before} triangles, at or under the budget {budget}: it was not reduced")
    t_dec = round(time.time() - t0, 1)
    dropped, dropped_files = None, []
    dmin = int(L.param("drop_pieces_under_tris", 0))
    if dmin > 0:  # loose little pieces of the REDUCED mesh (not of the dense part) are removed: each would be its own UV island with its own margin
        bm = bmesh.new()
        bm.from_mesh(lo.data)
        seen, kill, kill_area, tot_area = set(), [], 0.0, sum(f.calc_area() for f in bm.faces)
        for f0 in bm.faces:
            if f0.index in seen:
                continue
            comp, st = [], [f0]
            seen.add(f0.index)
            while st:
                f = st.pop()
                comp.append(f)
                for v in f.verts:
                    for f2 in v.link_faces:
                        if f2.index not in seen:
                            seen.add(f2.index)
                            st.append(f2)
            if sum(len(f.verts) - 2 for f in comp) < dmin:
                kill.append(comp)
        n_tris = 0
        listing = []
        for comp in kill:
            tr = sum(len(f.verts) - 2 for f in comp)
            ar = sum(f.calc_area() for f in comp)
            n_tris += tr
            kill_area += ar
            pts = np.array([list(lo.matrix_world @ v.co) for v in {v for f in comp for v in f.verts}])
            listing.append({"tris": tr, "area_mm2": round(ar * 1e6, 1), "centre_mm": [round(float(x) * 1000, 1) for x in (pts.min(0) + pts.max(0)) / 2], "size_mm": [round(float(x) * 1000, 1) for x in (pts.max(0) - pts.min(0))]})
        listing.sort(key=lambda d: -d["area_mm2"])
        dropped = {"pieces": len(kill), "tris": n_tris, "area_share_pct": round(100.0 * kill_area / max(tot_area, 1e-12), 2), "largest": listing[:25]}
        if kill:
            # a picture of the reduced mesh with the pieces about to go in red, so a shard can be told from a rivet or a strap end
            red, grey = bpy.data.materials.new("ub-drop"), bpy.data.materials.new("ub-keep")
            red.diffuse_color, grey.diffuse_color = (0.95, 0.1, 0.1, 1), (0.62, 0.64, 0.68, 1)
            lo.data.materials.append(grey)
            lo.data.materials.append(red)
            for f in bm.faces:
                f.material_index = 0
            for comp in kill:
                for f in comp:
                    f.material_index = 1
            bm.to_mesh(lo.data)
            Vv = np.array([(lo.matrix_world @ v.co)[:] for v in lo.data.vertices])
            mid, H = (Vv.max(0) + Vv.min(0)) / 2, float((Vv.max(0) - Vv.min(0)).max())
            for ob in scn.objects:
                ob.hide_render = ob is not lo
            for pth in HV.render_views([lo], Vector(mid), H * 1.2, "unwrapbake-dropped", res=int(L.param("res", 768)), dirs={"front": (0, -1, 0.2), "back": (0, 1, 0.2), "top": (0, 0, 1)}):
                dropped_files.append(pth)
            for ob in scn.objects:
                ob.hide_render = False
            bmesh.ops.delete(bm, geom=[f for comp in kill for f in comp], context="FACES")
            lo.data.materials.clear()
            bpy.data.materials.remove(red)
            bpy.data.materials.remove(grey)
        bm.to_mesh(lo.data)
        bm.free()
    after = L.tris(lo)

    # ---- unwrap
    t0 = time.time()
    uvl = lo.data.uv_layers.new(name="UV_lo")
    lo.data.uv_layers.active = uvl
    scn.tool_settings.use_uv_select_sync = True
    L.activate(lo, "EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    margin = float(L.param("island_margin", 0.004))
    method = L.param("method", "smart")
    if method == "smart":
        bpy.ops.uv.smart_project(angle_limit=math.radians(float(L.param("angle_limit_deg", 66))), island_margin=margin)
    elif method == "seams":
        bpy.ops.object.mode_set(mode="OBJECT")
        bm = bmesh.new()
        bm.from_mesh(lo.data)
        lim = math.radians(float(L.param("seam_deg", 60)))
        for e in bm.edges:
            e.seam = len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim or len(e.link_faces) != 2
        bm.to_mesh(lo.data)
        bm.free()
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.unwrap(method="ANGLE_BASED", fill_holes=True, margin=margin)
    else:
        raise RuntimeError('method must be "smart" or "seams"')
    if L.param("equalise", True):
        bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(udim_source="ACTIVE_UDIM", rotate=bool(L.param("rotate", True)), margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    t_unw = round(time.time() - t0, 1)
    stats, (tv, P, U, tl, tri_isl, cnt) = uv_stats(lo, "UV_lo")
    files = list(dropped_files)
    lay = os.path.join(L.ARGS["out_dir"], "unwrapbake-layout.png")
    UC.draw_layout(U, tri_isl, 2048, lay)
    files.append(lay)
    if stats["overlap_pct"] > 0.5:
        notes.append(f"{stats['overlap_pct']} % of the sheet is covered twice: islands overlap or fold")
    if stats["mesh_pieces"]["count"] > 50:
        notes.append(f"the reduced mesh is {stats['mesh_pieces']['count']} separate pieces ({stats['mesh_pieces']['tiny_under_20_tris']} under 20 triangles): every piece is its own UV island and every island costs a margin, so the sheet fills badly; the pieces come from the dense part (loose shells, details cut off from the body) and are not removed by this verb")
    if stats["stretch"]["p95"] > 1.5:
        notes.append(f"stretch p95 {stats['stretch']['p95']}: some islands are distorted (try method seams, or a larger budget)")

    # ---- bake (one pass set, dense -> reduced)
    images, secs, miss_pct, mat = [], {}, None, None
    if not dry:
        want = []
        if "albedo" in maps:
            want.append("albedo")
        if "normal" in maps:
            want.append("normal")
        if "orm" in maps:
            want += ["ao", "roughness", "metallic"]
        bb = np.array([(src.matrix_world @ v.co)[:] for v in src.data.vertices[:200000]])
        big = float((bb.max(0) - bb.min(0)).max())
        cage = float(L.param("cage_mm", big * 1000 * 0.015)) / 1000.0
        rayd = float(L.param("max_ray_mm", big * 1000 * 0.05)) / 1000.0
        tmat = bpy.data.materials.new(f"{name}-bake")
        tmat.use_nodes = True
        nt = tmat.node_tree
        for n in list(nt.nodes):
            if n.type != "OUTPUT_MATERIAL":
                nt.nodes.remove(n)
        imgs, tex = {}, {}
        uvmap = nt.nodes.new("ShaderNodeUVMap")
        uvmap.uv_map = "UV_lo"
        for p in want:
            im = bpy.data.images.new(f"{name}-{p}", size, size, alpha=False)
            im.colorspace_settings.name = PASSES[p][1]
            im.pixels.foreach_set(np.tile(np.array(FILL[p], np.float32), size * size))
            imgs[p] = im
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = im
            nt.links.new(uvmap.outputs["UV"], t.inputs["Vector"])
            tex[p] = t
        lo.data.materials.append(tmat)
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = int(L.param("samples", 8))
        mpx = int(L.param("margin_px", 16))
        for p in want:
            t0 = time.time()
            restore = []
            if p == "metallic":  # bake the metallic value as emission colour from copies of the dense part's materials
                for slot in src.material_slots:
                    m = slot.material
                    if m is None or not m.use_nodes:
                        continue
                    m2 = m.copy()
                    Pn = next((n for n in m2.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                    if Pn is None:
                        continue
                    mi = Pn.inputs["Metallic"]
                    if mi.is_linked:
                        m2.node_tree.links.new(mi.links[0].from_socket, Pn.inputs["Emission Color"])
                    else:
                        v = mi.default_value
                        Pn.inputs["Emission Color"].default_value = (v, v, v, 1)
                    Pn.inputs["Emission Strength"].default_value = 1.0
                    restore.append((slot, m))
                    slot.material = m2
            for n in nt.nodes:
                n.select = False
            tex[p].select = True
            nt.nodes.active = tex[p]
            bpy.ops.object.select_all(action="DESELECT")
            src.select_set(True)
            lo.select_set(True)
            bpy.context.view_layer.objects.active = lo
            kw = {"type": PASSES[p][0], "use_selected_to_active": True, "margin": mpx, "use_clear": False, "target": "IMAGE_TEXTURES", "normal_space": "TANGENT",
                  "cage_extrusion": cage, "max_ray_distance": rayd}
            if p == "albedo":
                kw["pass_filter"] = {"COLOR"}
            bpy.ops.object.bake(**kw)
            for slot, m in restore:
                slot.material = m
            secs[p] = round(time.time() - t0, 1)
        arr = {}
        for p, im in imgs.items():
            a = np.empty(size * size * 4, np.float32)
            im.pixels.foreach_get(a)
            arr[p] = a.reshape(size, size, 4)
        if "albedo" in arr:
            mask = cnt >= 1
            if size != cnt.shape[0]:
                mask = UC.raster_counts(U, size) >= 1
            isf = (np.abs(arr["albedo"][..., :3] - np.array(FILL["albedo"][:3])) < 0.02).all(-1)
            miss_pct = round(float((isf & mask).sum() / max(mask.sum(), 1) * 100), 2)
            if miss_pct > 2:
                notes.append(f"{miss_pct} % of the island texels were not reached by a ray: raise cage_mm / max_ray_mm, or check that the dense part and the result coincide")
            # texels no island uses (and the misses) get the mean colour of the texels that were baked, not the magenta marker
            rgb = arr["albedo"][..., :3]
            tinted = (rgb[..., 0] > 0.5) & (rgb[..., 2] > 0.5) & (rgb[..., 1] < 0.4) & (rgb[..., 0] - rgb[..., 1] > 0.3) & (rgb[..., 2] - rgb[..., 1] > 0.3)  # the marker colour and its blended edge
            good = ~(isf | tinted)
            if good.any():
                mean_rgb = rgb[good].mean(0)
                rgb[isf | tinted] = mean_rgb
                imgs["albedo"].pixels.foreach_set(arr["albedo"].ravel())
        # the final material: albedo, normal map, ORM
        mat = bpy.data.materials.new(f"{name}-baked")
        mat.use_nodes = True
        nt2 = mat.node_tree
        for n in list(nt2.nodes):
            if n.type != "OUTPUT_MATERIAL":
                nt2.nodes.remove(n)
        out_n = next(n for n in nt2.nodes if n.type == "OUTPUT_MATERIAL")
        pr = nt2.nodes.new("ShaderNodeBsdfPrincipled")
        nt2.links.new(pr.outputs["BSDF"], out_n.inputs["Surface"])
        uvn = nt2.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "UV_lo"

        def tex_node(im):
            t = nt2.nodes.new("ShaderNodeTexImage")
            t.image = im
            nt2.links.new(uvn.outputs["UV"], t.inputs["Vector"])
            return t
        outd = L.ARGS["out_dir"]

        def save(im, fname, cs):
            path = os.path.join(outd, fname)
            im.filepath_raw = path
            im.file_format = "PNG"
            im.save()
            im.pack()
            files.append(path)
            images.append({"file": fname, "size": size, "colour_space": cs})
        if "albedo" in imgs:
            save(imgs["albedo"], f"{name}-albedo.png", "sRGB")
            nt2.links.new(tex_node(imgs["albedo"]).outputs["Color"], pr.inputs["Base Color"])
        if "normal" in imgs:
            save(imgs["normal"], f"{name}-normal.png", "Non-Color")
            nm = nt2.nodes.new("ShaderNodeNormalMap")
            nm.uv_map = "UV_lo"
            nt2.links.new(tex_node(imgs["normal"]).outputs["Color"], nm.inputs["Color"])
            nt2.links.new(nm.outputs["Normal"], pr.inputs["Normal"])
        if "orm" in maps:
            o = np.ones((size, size, 4), np.float32)
            o[..., 0] = arr["ao"][..., 0]
            o[..., 1] = arr["roughness"][..., 0]
            o[..., 2] = arr["metallic"][..., 0]
            im = bpy.data.images.new(f"{name}-orm", size, size, alpha=False)
            im.colorspace_settings.name = "Non-Color"
            im.pixels.foreach_set(o.ravel())
            save(im, f"{name}-orm.png", "Non-Color")
            sep = nt2.nodes.new("ShaderNodeSeparateColor")
            nt2.links.new(tex_node(im).outputs["Color"], sep.inputs["Color"])
            nt2.links.new(sep.outputs["Green"], pr.inputs["Roughness"])
            nt2.links.new(sep.outputs["Blue"], pr.inputs["Metallic"])
        for p in ("ao", "roughness", "metallic"):
            if p in imgs:
                bpy.data.images.remove(imgs[p])
        lo.data.materials.clear()
        lo.data.materials.append(mat)
        bpy.data.materials.remove(tmat)

    # ---- checker pictures of the result
    views = L.param("views", ["front", "back"]) or []
    if views:
        res = int(L.param("res", 768))
        M.workbench(scn, res)
        for ob in scn.objects:
            ob.hide_render = ob is not lo
        saved_mats = list(lo.data.materials)
        img = bpy.data.images.new("ub-grid", 1024, 1024)
        img.generated_type = "COLOR_GRID"
        cm = bpy.data.materials.new("ub-checker")
        cm.use_nodes = True
        ntc = cm.node_tree
        tx = ntc.nodes.new("ShaderNodeTexImage")
        tx.image = img
        ntc.links.new(tx.outputs["Color"], ntc.nodes["Principled BSDF"].inputs["Base Color"])
        um = ntc.nodes.new("ShaderNodeUVMap")
        um.uv_map = "UV_lo"
        tm = ntc.nodes.new("ShaderNodeMapping")
        tm.inputs["Scale"].default_value = (2.0, 2.0, 2.0)
        ntc.links.new(um.outputs["UV"], tm.inputs["Vector"])
        ntc.links.new(tm.outputs["Vector"], tx.inputs["Vector"])
        lo.data.materials.clear()
        lo.data.materials.append(cm)
        scn.display.shading.color_type = "TEXTURE"
        cam = bpy.data.objects.new("ubcam", bpy.data.cameras.new("ubcam"))
        scn.collection.objects.link(cam)
        scn.camera = cam
        cam.data.type = "ORTHO"
        cam.data.clip_start, cam.data.clip_end = 0.01, 60
        Vv = np.array([(lo.matrix_world @ v.co)[:] for v in lo.data.vertices])
        mid, H = (Vv.max(0) + Vv.min(0)) / 2, float((Vv.max(0) - Vv.min(0)).max())
        for v in views:
            if v not in DIRS:
                raise RuntimeError(f"view must be one of {', '.join(DIRS)}")
            d = Vector(DIRS[v]).normalized()
            cam.location = Vector(mid) + d * 6
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            cam.data.ortho_scale = H * 1.2
            p = os.path.join(L.ARGS["out_dir"], f"unwrapbake-checker-{v}.png")
            scn.render.filepath = p
            bpy.ops.render.render(write_still=True)
            files.append(p)
        bpy.data.objects.remove(cam, do_unlink=True)
        lo.data.materials.clear()
        for m in saved_mats:
            lo.data.materials.append(m)
        bpy.data.materials.remove(cm)
        bpy.data.images.remove(img)
        for ob in scn.objects:
            ob.hide_render = False

    summary = {"part": src.name, "result": name, "tris_before": before, "tris_after": after, "decimate_ratio": round(after / max(before, 1), 4), "dropped_small_pieces": dropped, "dry_run": dry, **stats}
    if dry:
        bpy.data.objects.remove(lo, do_unlink=True)
    else:
        if L.param("replace", False):
            bpy.data.objects.remove(src, do_unlink=True)
        else:
            src.hide_set(True)
            src.hide_render = True
    L.finish(summary, files=files, save=not dry, images=images, bake_misses_pct=miss_pct, material=mat.name if mat else None, uv="UV_lo",
             seconds={"decimate": t_dec, "unwrap": t_unw, "bake": secs, "total": round(time.time() - t_all, 1)}, notes=notes)


L.run(main)
