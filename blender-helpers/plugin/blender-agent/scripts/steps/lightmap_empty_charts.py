"""lightmap_empty_charts — READ-ONLY: find the charts of a finished lightmap layout that hold NO texel centre at all, and say where they are and what they are. Run it on a COPY of the bake checkpoint. Saves nothing.
For every empty chart: receiver, triangles, 3D area, the size of its minimum bounding rectangle in the LightmapUV in texels and in cm on the surface, world centroid and bounding box, mean face normal (Blender frame) and direction (up / side / down), `thin` (3D area under 4 cm2), a ray from just outside the surface along the normal (distance to the first hit and what it hits: 'open' when nothing within `ray_m`), and a verdict: `hidden_contact` (a hit within 3 cm: pressed against another part), `tiny_face_under_4_cm2`, `uv_area_under_1_texel2_but_3d_area_over_4_cm2` (a real surface squeezed to nothing in UV), `enclosed` (a hit within ray_m), `exposed` (open to ray_m).
params: highlight ({"top": 7, "res": 900, "views": [{"name", "focus": "empty" | "all", "dir": [x, y, z], "margin"}]}: renders the largest empty charts as coloured emission patches 6 mm off the surface over neutral grey clay, two default views (a close-up along their mean normal and a wide view), a `highlight_legend` of colour -> chart; nothing stays changed), atlas_px (default 1024), tie_rule ("inclusive" | "top_left_b", default top_left_b: the loader's rule), ray_m (default 10), receivers (default: every mesh with a LightmapUV), top (default 40)
Returns: totals (charts, empty charts, area), by verdict (count, area), by receiver, and the `top` largest with all fields.
"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def charts_of(me):
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    uv = me.uv_layers[LB.LM].data
    seen = {}
    for poly in me.polygons:
        ls = list(poly.loop_indices)
        for l in ls[1:]:
            parent[find(ls[0])] = find(l)
        for l in ls:
            co = me.vertices[me.loops[l].vertex_index].co
            k = (round(co[0], 5), round(co[1], 5), round(co[2], 5), round(uv[l].uv[0], 5), round(uv[l].uv[1], 5))  # joined by POSITION + UV (as on the welded copies the baker packs), not by vertex index
            if k in seen:
                parent[find(seen[k])] = find(l)
            else:
                seen[k] = l
    out = {}
    for l in range(len(me.loops)):
        out.setdefault(find(l), []).append(l)
    return list(out.values())


def main():
    atlas = int(L.param("atlas_px", 1024))
    LB.TIE_RULE[0] = L.param("tie_rule", "top_left_b")
    ray_m = float(L.param("ray_m", 10))
    pats = L.param("receivers")
    recv = [o for o in bpy.context.scene.objects if o.type == "MESH" and LB.LM in o.data.uv_layers and (not pats or any(fnmatch.fnmatchcase(o.name, p) for p in pats))]
    LB.CHARTS.clear()
    LB.ITEMS[:] = []
    cover, pos, nrm, owner, stats, empty = LB.raster(recv, atlas)
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    rows, total_charts, hl_keep = [], 0, []
    for oi, o in enumerate(recv):
        me = o.data
        me.calc_loop_triangles()
        hits, la = LB.LASTHITS[oi]
        uv = me.uv_layers[LB.LM].data
        mw = o.matrix_world
        l2poly = {}
        for p in me.polygons:
            for li in p.loop_indices:
                l2poly[li] = p.index
        for ch in charts_of(me):
            total_charts += 1
            if any(l in hits for l in ch):
                continue
            polys = sorted({l2poly[l] for l in ch})
            area = sum(me.polygons[p].area for p in polys) * (mw.to_scale()[0] * mw.to_scale()[1])
            us = np.array([uv[l].uv[:] for l in ch]) * atlas
            h = LB.hull2d([tuple(p) for p in us])
            _, bw, bh, _ = LB.min_rect(h if len(h) >= 3 else [tuple(p) for p in us])
            cen = sum((mw @ me.polygons[p].center for p in polys), Vector()) / len(polys)
            nm = Vector()
            for p in polys:
                nm += (mw.to_3x3() @ me.polygons[p].normal) * me.polygons[p].area
            nm = nm.normalized() if nm.length > 0 else Vector((0, 0, 1))
            pts = [mw @ me.vertices[v].co for p in polys for v in me.polygons[p].vertices]
            lo = [min(q[i] for q in pts) for i in range(3)]
            hi = [max(q[i] for q in pts) for i in range(3)]
            dims = sorted(hi[i] - lo[i] for i in range(3))
            short_cm = (dims[1] if dims[0] < 1e-4 else dims[0]) * 100  # a flat face has one zero extent: the shortest REAL side
            o_ = cen + nm * 0.002
            ok_, loc, nn, fi, ob, mat = scn.ray_cast(dg, o_, nm, distance=ray_m)
            hit_d = (loc - o_).length if ok_ else None
            tri_uv = []
            for t in me.loop_triangles:
                if t.polygon_index in set(polys):
                    q = [np.array(uv[l].uv[:]) * atlas for l in t.loops]
                    tri_uv.append(abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0])) / 2)
            uv_area = float(sum(tri_uv))
            thin = area * 1e4 < 4.0
            if hit_d is not None and hit_d < 0.03:
                v = "hidden_contact"
            elif thin:
                v = "tiny_face_under_4_cm2"
            elif uv_area < 1.0:
                v = "uv_area_under_1_texel2_but_3d_area_over_4_cm2"
            elif hit_d is not None:
                v = "enclosed"
            else:
                v = "exposed"
            hl_keep.append((o.name, polys, area))
            rows.append({"polygons": len(polys), "uv_area_texels2": round(uv_area, 4), "uv_degenerate_triangles": int(sum(1 for a_ in tri_uv if a_ < 1e-6)), "receiver": o.name, "triangles": sum(1 for t in me.loop_triangles if t.polygon_index in set(polys)), "area_m2": round(area, 5), "area_cm2": round(area * 1e4, 1), "uv_rect_texels": [round(bw, 2), round(bh, 2)],
                         "shortest_world_side_cm": round(short_cm, 2), "centroid_m": [round(c, 3) for c in cen], "bbox_m": [[round(x, 3) for x in lo], [round(x, 3) for x in hi]], "normal": [round(c, 3) for c in nm],
                         "direction": "up" if nm.z > 0.5 else ("down" if nm.z < -0.5 else "side"), "thin": thin, "ray_first_hit_m": round(hit_d, 4) if hit_d is not None else None, "ray_hits": ob.name if ok_ else None, "verdict": v})
    files, legend = [], []
    hl = L.param("highlight")
    if hl:
        order = sorted(range(len(rows)), key=lambda i: -rows[i]["area_m2"])[:int(hl.get("top", 7))]
        palette = [(1, 0, 0), (1, 0.5, 0), (1, 0, 1), (0, 0.6, 1), (0, 0.8, 0.2), (1, 0.9, 0), (0.6, 0.2, 1), (0, 1, 1)]
        import bmesh
        made, mats_hl = [], []
        for rank, i in enumerate(order):
            on, polys, ar = hl_keep[i]
            o = bpy.data.objects[on]
            me = o.data
            bm = bmesh.new()
            for p_ in polys:
                pg = me.polygons[p_]
                nW = (o.matrix_world.to_3x3() @ pg.normal).normalized()
                vs = [bm.verts.new(o.matrix_world @ me.vertices[v].co + nW * 0.006) for v in pg.vertices]
                try:
                    bm.faces.new(vs)
                except ValueError:
                    pass
            m2 = bpy.data.meshes.new(f"ec_hl_{rank}")
            bm.to_mesh(m2)
            bm.free()
            ob = bpy.data.objects.new(f"ec_hl_{rank}", m2)
            scn.collection.objects.link(ob)
            mt = bpy.data.materials.new(f"ec_hl_m{rank}")
            mt.use_nodes = True
            nt = mt.node_tree
            nt.nodes.clear()
            e = nt.nodes.new("ShaderNodeEmission")
            c = palette[rank % len(palette)]
            e.inputs["Color"].default_value = (c[0], c[1], c[2], 1)
            e.inputs["Strength"].default_value = 3.0
            oo = nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(e.outputs["Emission"], oo.inputs["Surface"])
            m2.materials.append(mt)
            made.append(ob)
            mats_hl.append(mt)
            r = rows[i]
            legend.append({"colour_rgb": list(c), "rank": rank + 1, "receiver": r["receiver"], "area_cm2": r["area_cm2"], "centroid_m": r["centroid_m"], "normal": r["normal"], "verdict": r["verdict"]})
        neutral = bpy.data.materials.new("ec_neutral")
        neutral.use_nodes = True
        neutral.node_tree.nodes.clear()
        dd = neutral.node_tree.nodes.new("ShaderNodeBsdfDiffuse")
        dd.inputs["Color"].default_value = (0.75, 0.75, 0.75, 1)
        o2 = neutral.node_tree.nodes.new("ShaderNodeOutputMaterial")
        neutral.node_tree.links.new(dd.outputs["BSDF"], o2.inputs["Surface"])
        slots0 = {o.name: [sl.material for sl in o.material_slots] for o in recv}
        for o in recv:
            for sl in o.material_slots:
                sl.material = neutral
        hid = {o.name: o.hide_render for o in scn.objects}
        old = (scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world, scn.view_settings.view_transform)
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = int(hl.get("samples", 24))
        scn.cycles.use_denoising = False
        res = int(hl.get("res", 900))
        scn.render.resolution_x = scn.render.resolution_y = res
        scn.render.resolution_percentage = 100
        scn.view_settings.view_transform = "Standard"
        w = bpy.data.worlds.new("ec_world")
        w.use_nodes = True
        w.node_tree.nodes["Background"].inputs[0].default_value = (0.7, 0.7, 0.7, 1)
        w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
        scn.world = w
        sd = bpy.data.lights.new("ec_sun", "SUN")
        sd.energy = 2.5
        sun = bpy.data.objects.new("ec_sun", sd)
        scn.collection.objects.link(sun)
        cd = bpy.data.cameras.new("ec_cam")
        cd.type = "ORTHO"
        cam = bpy.data.objects.new("ec_cam", cd)
        scn.collection.objects.link(cam)
        scn.camera = cam
        try:
            pts_h = [v for ob in made for v in (ob.matrix_world @ Vector(c_) for c_ in ob.bound_box)]
            lo_h = Vector((min(p.x for p in pts_h), min(p.y for p in pts_h), min(p.z for p in pts_h)))
            hi_h = Vector((max(p.x for p in pts_h), max(p.y for p in pts_h), max(p.z for p in pts_h)))
            mean_n = Vector()
            for g in legend:
                mean_n += Vector(g["normal"])
            mean_n = mean_n.normalized() if mean_n.length > 0 else Vector((0, -1, 0))
            for vw in hl.get("views", [{"name": "closeup", "focus": "empty", "margin": 2.5}, {"name": "wide", "focus": "all", "dir": [0.3, -1.0, 0.45], "margin": 1.0}]):
                d = Vector(vw.get("dir", list(mean_n))).normalized()
                if vw.get("focus", "empty") == "empty":
                    ctr = (lo_h + hi_h) / 2
                    size = max((hi_h - lo_h).length, 0.5) * float(vw.get("margin", 2.5)) * 0.6
                    show = [o for o in recv]
                else:
                    pts = [o.matrix_world @ Vector(c_) for o in recv for c_ in o.bound_box]
                    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
                    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
                    ctr = (lo + hi) / 2
                    size = (hi - lo).length * float(vw.get("margin", 1.0)) * 0.6
                    show = [o for o in recv]
                cd.ortho_scale = size
                cd.clip_start, cd.clip_end = 0.01, max(80.0, size * 8)
                cam.location = ctr + d * max(20.0, size * 3)
                cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
                sdir = Vector(hl.get("sun_dir", [0.3, -0.6, 1.0])).normalized()
                sun.rotation_euler = (-sdir).to_track_quat("-Z", "Y").to_euler()
                for o in scn.objects:
                    o.hide_render = not (o in show or o in made or o in (cam, sun))
                path = os.path.join(L.ARGS["out_dir"], f"{hl.get('prefix', 'emptycharts')}-{vw['name']}.png")
                scn.render.filepath = path
                bpy.ops.render.render(write_still=True)
                files.append(path)
        finally:
            for nm, ms in slots0.items():
                o = bpy.data.objects.get(nm)
                for sl, m in zip(o.material_slots, ms):
                    sl.material = m
            for o in scn.objects:
                if o.name in hid:
                    o.hide_render = hid[o.name]
            for ob in made + [cam, sun]:
                bpy.data.objects.remove(ob, do_unlink=True)
            scn.render.engine, scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage, scn.camera, scn.world, scn.view_settings.view_transform = old
    by_v, by_r = {}, {}
    for r in rows:
        d = by_v.setdefault(r["verdict"], {"charts": 0, "area_m2": 0.0})
        d["charts"] += 1
        d["area_m2"] = round(d["area_m2"] + r["area_m2"], 4)
        e = by_r.setdefault(r["receiver"], {"charts": 0, "area_m2": 0.0})
        e["charts"] += 1
        e["area_m2"] = round(e["area_m2"] + r["area_m2"], 4)
    rows.sort(key=lambda r: -r["area_m2"])
    L.finish({"tie_rule": LB.TIE_RULE[0], "atlas_px": atlas, "charts_total": total_charts, "empty_charts": len(rows), "empty_area_m2": round(sum(r["area_m2"] for r in rows), 4), "by_verdict": by_v,
              "by_receiver": dict(sorted(by_r.items(), key=lambda kv: -kv[1]["area_m2"])[:25])}, save=False, files=files, highlight_legend=legend, empty=rows[:int(L.param("top", 40))])


L.run(main)
