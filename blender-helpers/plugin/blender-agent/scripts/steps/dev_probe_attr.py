"""dev_probe_attr — DEV TOOL, read-only: for every probe of one object in a bake's probes.json that stored 0 for a bulb: facing (probe normal . direction to the bulb), the baker-style ray from the probe point lifted along its normal (first caster hit, distance, hit-normal dot), the same ray from a point lifted 2 mm toward the bulb side, which triangles of the object's LightmapUV hold the texel centre (polygon, geometric normal, tie), and the value stored in the bin at the glTF row.
params: probes (path), object, light (e.g. "bulb_1.light"), bulb (key in values, e.g. "1"), bin, channel, atlas_px (1024), only_zero (true)"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def first_hit(scn, dg, org, tgt, casters):
    d = tgt - org
    dist = d.length
    dirv = d / dist
    o = org
    left = dist
    for _ in range(12):
        hit, loc, hn, idx, ob, mw = scn.ray_cast(dg, o, dirv, distance=left)
        if not hit:
            return None
        if ob.name in casters:
            return {"object": ob.name, "at_m": round((loc - org).length, 4), "hit_normal_dot_dir": round(float(hn.normalized().dot(dirv)), 3), "polygon": idx}
        left -= (loc - o).length + 1e-4
        o = loc + dirv * 1e-4
        if left <= 0:
            return None


def all_hits(scn, dg, org, tgt):
    d = tgt - org
    dirv = d / d.length
    o, left, out = org, d.length, []
    for _ in range(12):
        hit, loc, hn, idx, ob, mw = scn.ray_cast(dg, o, dirv, distance=left)
        if not hit:
            break
        out.append([ob.name.replace("static__SceneAssembly__", ""), round((loc - org).length, 4)])
        left -= (loc - o).length + 1e-4
        o = loc + dirv * 1e-4
        if left <= 0:
            break
    return out


def o_flags(name):
    o = bpy.data.objects[name]
    return "hv=%d hr=%d vs=%d" % (o.hide_viewport, o.hide_render, o.visible_shadow)


def main():
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    lp = bpy.data.objects[L.param("light")].matrix_world.translation
    import fnmatch
    excl = L.param("exclude", [])
    casters = {o.name for o in scn.objects if o.type == "MESH" and not o.hide_render and o.visible_shadow and not any(fnmatch.fnmatchcase(o.name, g) for g in excl)}
    A = int(L.param("atlas_px", 1024))
    ob = bpy.data.objects[L.param("object")]
    me = ob.data
    me.calc_loop_triangles()
    uvl = me.uv_layers["LightmapUV"].data
    nm = ob.matrix_world.to_3x3().inverted_safe().transposed()
    data = np.frombuffer(open(L.resolve(L.param("bin")), "rb").read(), dtype="<f2").reshape(A, A, 4).astype(np.float64)
    ch = int(L.param("channel", 0))
    pr = json.load(open(L.resolve(L.param("probes"))))["probes"]
    bvhs = {}
    for o_ in scn.objects:
        if o_.type == "MESH" and o_.name != ob.name:
            try:
                bvhs[o_.name] = BVHTree.FromObject(o_, dg)
            except Exception:
                pass
    out = []
    for p in pr:
        if p["object"] != ob.name or (L.param("only_zero", True) and p["values"].get(L.param("bulb")) != 0.0):
            continue
        w = Vector(p["world_m"])
        n = Vector(p["normal"])
        x, y = p["texel"]
        facing = float(n.dot((lp - w).normalized()))
        row = {"texel_gltf": [x, y], "world": [round(c, 4) for c in w], "normal": p["normal"], "facing_dot": round(facing, 3), "distance_m": round((lp - w).length, 3),
               "bin_at_gltf_row": round(float(data[y, x, ch]), 5), "bin_at_flipped_row": round(float(data[A - 1 - y, x, ch]), 5),
               "ray_lift_normal": first_hit(scn, dg, w + n * 2e-3, lp, casters), "ray_lift_toward_bulb_side": first_hit(scn, dg, w + (n if facing >= 0 else -n) * 2e-3, lp, casters), "ray_no_lift": first_hit(scn, dg, w, lp, casters), "ray_lift_0.1mm": first_hit(scn, dg, w + n * 1e-4, lp, casters), "ray_lift_0.3mm": first_hit(scn, dg, w + n * 3e-4, lp, casters), "all_hits_ignoring_exclusion": all_hits(scn, dg, w + n * 2e-3, lp)}
        dv_ = (lp - (w + n * 2e-3))
        dl_ = dv_.length
        dd_ = dv_ / dl_
        row["brute_blockers_any_object"] = sorted({(nm_.replace("static__SceneAssembly__", ""), o_flags(nm_), round(h[3], 3)) for nm_, bv in bvhs.items() for h in [bv.ray_cast(w + n * 2e-3, dd_, dl_)] if h[0] is not None})
        near = []
        mw_ = ob.matrix_world
        for t in me.loop_triangles:
            va, vb, vc = (mw_ @ me.vertices[v].co for v in t.vertices)
            nn_ = (vb - va).cross(vc - va)
            if nn_.length < 1e-12:
                continue
            nn_.normalize()
            dpl = (w - va).dot(nn_)
            if abs(dpl) > 4e-3:
                continue
            q = w - nn_ * dpl
            v0_, v1_, v2_ = vb - va, vc - va, q - va
            d00, d01, d11, d20, d21 = v0_.dot(v0_), v0_.dot(v1_), v1_.dot(v1_), v2_.dot(v0_), v2_.dot(v1_)
            den = d00 * d11 - d01 * d01
            if abs(den) < 1e-14:
                continue
            bv_ = (d11 * d20 - d01 * d21) / den
            bw_ = (d00 * d21 - d01 * d20) / den
            if min(bv_, bw_, 1 - bv_ - bw_) >= -1e-3:
                near.append({"polygon": t.polygon_index, "plane_dist_mm": round(dpl * 1000, 2), "normal": [round(c, 3) for c in nn_]})
        row["own_triangles_through_point_within_4mm"] = near
        cx, cy = x + 0.5, (A - 1 - y if L.param("flip_y", False) else y) + 0.5
        tris = []
        for t in me.loop_triangles:
            a, b, c = [(uvl[l].uv[0] * A, (1 - uvl[l].uv[1]) * A) for l in t.loops]
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
                b, c = c, b
            e = [(b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]), (c[0] - b[0]) * (cy - b[1]) - (c[1] - b[1]) * (cx - b[0]), (a[0] - c[0]) * (cy - c[1]) - (c[1] - a[1]) * 0 - (c[0] - a[0]) * 0 + 0]
            e[2] = (a[0] - c[0]) * (cy - c[1]) - (a[1] - c[1]) * (cx - c[0])
            if min(e) >= -1e-6:
                nn = (nm @ t.normal).normalized()
                tris.append({"polygon": t.polygon_index, "normal": [round(v, 3) for v in nn], "on_edge": any(abs(v) < 1e-6 for v in e)})
        row["uv_triangles_holding_centre"] = tris
        if tris:
            pg = me.polygons[tris[0]["polygon"]]
            cn = me.corner_normals
            row["shading"] = {"has_custom_normals": me.has_custom_normals, "polygon_normal_world": [round(v, 3) for v in (nm @ pg.normal).normalized()],
                              "corner_normals_world": [[round(v, 3) for v in (nm @ Vector(cn[l].vector)).normalized()] for l in pg.loop_indices], "use_smooth": pg.use_smooth, "material": ob.material_slots[pg.material_index].name if pg.material_index < len(ob.material_slots) else None}
        out.append(row)
    info = {}
    for nm_ in sorted({r["ray_lift_normal"]["object"] for r in out if r["ray_lift_normal"]}):
        g = bpy.data.objects[nm_]
        mats = []
        for m in g.data.materials:
            pb = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m and m.use_nodes else None
            mats.append({"material": m.name if m else None, "alpha": round(pb.inputs["Alpha"].default_value, 3) if pb else None, "alpha_linked": bool(pb.inputs["Alpha"].is_linked) if pb else None,
                         "transmission": round(pb.inputs["Transmission Weight"].default_value, 3) if pb and "Transmission Weight" in pb.inputs else None})
        info[nm_] = {"visible_shadow": g.visible_shadow, "hide_render": g.hide_render, "materials": mats}
    lo = bpy.data.objects[L.param("light")]
    ll = lo.light_linking
    li = {"type": lo.data.type, "energy": lo.data.energy, "use_shadow": lo.data.use_shadow, "soft_size": lo.data.shadow_soft_size, "receiver_collection": ll.receiver_collection.name if ll.receiver_collection else None, "receiver_type": ll.receiver_type if hasattr(ll, "receiver_type") else None,
          "blocker_collection": ll.blocker_collection.name if ll.blocker_collection else None, "blocker_type": getattr(ll, "blocker_type", None)}
    ob_vis = {k: getattr(ob, k, None) for k in ("visible_camera", "visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter", "visible_shadow", "is_shadow_catcher", "is_holdout", "hide_render")}
    others = {o.name: {"receiver_collection": o.light_linking.receiver_collection.name if o.light_linking.receiver_collection else None, "blocker_collection": o.light_linking.blocker_collection.name if o.light_linking.blocker_collection else None} for o in scn.objects if o.type == "LIGHT" and (o.light_linking.receiver_collection or o.light_linking.blocker_collection)}
    L.finish("attr done", save=False, light=li, receiver_vis=ob_vis, linked_lights=others, casters=info, probes=out)


L.run(main)
