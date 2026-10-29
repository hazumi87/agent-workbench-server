"""glb_bulb_audit — READ-ONLY audit of where the bulb assemblies sit relative to the other geometry of a SERVED GLB (imported into a fresh scene; nothing is saved). For every `bulb_*.diffuser`: its world centre and radius, and for every non-bulb mesh the distance from the centre to the nearest surface, whether the centre lies INSIDE a closed solid (ray parity), and whether the diffuser's sphere intersects it; plus every other mesh in a column below the diffuser. Also lists all meshes whose names look like bulbs/lamps that are not part of a `bulb_*` assembly.
params: glb (path)   [required]; column_m (default 0.35: half width of the column below a diffuser); below_m (default 1.5: how far down); top (default 15)
Returns: counts of bulb nodes by role, the diffuser radius and centre heights, bulbs whose centre is inside a solid or within one radius of a non-bulb surface (with the object names), a summary by object, the other bulb-like meshes, meshes found in the columns below the diffusers, and a vertical profile of the pergola (lowest/highest z of the louvers and beams).
"""
import fnmatch
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402


def main():
    gp = L.resolve(L.param("glb"), what="glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=gp)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    objs = [o for o in bpy.context.scene.objects]
    roles = {}
    bulbs = {}
    for o in objs:
        m = re.match(r"^bulb_([AB]-\d+)\.(diffuser|mount|wire_a|wire_b|socket|light)", o.name)
        if m:
            roles[m.group(2)] = roles.get(m.group(2), 0) + 1
            bulbs.setdefault(m.group(1), {})[m.group(2)] = o
    meshes = [o for o in objs if o.type == "MESH"]
    non_bulb = [o for o in meshes if not o.name.startswith("bulb_")]

    def bb(o):
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        return Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    bvh = {}
    for o in non_bulb:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.transform(o.matrix_world)
        bvh[o.name] = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [tuple(p.vertices) for p in me.polygons], all_triangles=False)
        ev.to_mesh_clear()
    bounds = {o.name: bb(o) for o in non_bulb}
    column_m = float(L.param("column_m", 0.35))
    below_m = float(L.param("below_m", 1.5))
    rows, by_obj, below_by_obj = [], {}, {}
    firsthit, within25 = {"up": {}, "down": {}}, {}
    zs, rs = [], []
    for bid, parts in sorted(bulbs.items()):
        d = parts.get("diffuser")
        if d is None:
            continue
        lo, hi = bb(d)
        c = (lo + hi) / 2
        r = max((hi - lo).x, (hi - lo).y, (hi - lo).z) / 2
        zs.append(c.z)
        rs.append(r)
        near, inside = [], []
        for nm, tree in bvh.items():
            blo, bhi = bounds[nm]
            if c.x < blo.x - r or c.x > bhi.x + r or c.y < blo.y - r or c.y > bhi.y + r or c.z < blo.z - r or c.z > bhi.z + r:
                continue
            loc, nrm, idx, dist = tree.find_nearest(c)
            if dist is not None and dist <= r:
                near.append((nm, round(dist, 4)))
            # inside a closed solid: odd number of surface crossings along +Z and along -Z
            def crossings(dirv):
                n, org = 0, c.copy()
                for _ in range(40):
                    h = tree.ray_cast(org, dirv)
                    if h[0] is None:
                        break
                    n += 1
                    org = h[0] + dirv * 1e-5
                return n
            up, dn = crossings(Vector((0, 0, 1))), crossings(Vector((0, 0, -1)))
            if up % 2 == 1 and dn % 2 == 1:
                inside.append(nm)
        for nm, dist in near:
            e = by_obj.setdefault(nm, {"bulbs_whose_diffuser_sphere_touches": 0, "min_distance_m": 9.0, "inside_solid_for": 0})
            e["bulbs_whose_diffuser_sphere_touches"] += 1
            e["min_distance_m"] = min(e["min_distance_m"], dist)
        for nm in inside:
            by_obj.setdefault(nm, {"bulbs_whose_diffuser_sphere_touches": 0, "min_distance_m": 9.0, "inside_solid_for": 0})["inside_solid_for"] += 1
        # first hit straight up and straight down from the centre, and everything within 0.25 m of the centre
        for tag, dv in (("up", Vector((0, 0, 1))), ("down", Vector((0, 0, -1)))):
            best = None
            for nm, tree in bvh.items():
                h = tree.ray_cast(c, dv)
                if h[0] is not None and (best is None or h[3] < best[1]):
                    best = (nm, h[3])
            if best:
                e = firsthit[tag].setdefault(best[0], {"bulbs": 0, "min_m": 99.0, "max_m": 0.0})
                e["bulbs"] += 1
                e["min_m"] = min(e["min_m"], best[1])
                e["max_m"] = max(e["max_m"], best[1])
        for nm, tree in bvh.items():
            blo, bhi = bounds[nm]
            if c.x < blo.x - 0.25 or c.x > bhi.x + 0.25 or c.y < blo.y - 0.25 or c.y > bhi.y + 0.25 or c.z < blo.z - 0.25 or c.z > bhi.z + 0.25:
                continue
            loc, nrm, idx, dist = tree.find_nearest(c)
            if dist is not None and dist <= 0.25:
                e = within25.setdefault(nm, {"bulbs": 0, "min_m": 9.0})
                e["bulbs"] += 1
                e["min_m"] = min(e["min_m"], dist)
        # column below
        for nm, (blo, bhi) in bounds.items():
            if bhi.z < c.z - below_m or blo.z > c.z - r:
                continue
            if bhi.x < c.x - column_m or blo.x > c.x + column_m or bhi.y < c.y - column_m or blo.y > c.y + column_m:
                continue
            loc, nrm, idx, dist = bvh[nm].find_nearest(c)
            below_by_obj.setdefault(nm, 0)
            below_by_obj[nm] += 1
        if near or inside:
            rows.append({"bulb": bid, "centre_m": [round(x, 4) for x in c], "radius_m": round(r, 4), "touching": near[:6], "centre_inside_solid_of": inside[:4]})
    other = sorted(o.name for o in meshes if re.search(r"bulb|lamp|light|globe|edison|sconce|string", o.name, re.I) and not o.name.startswith("bulb_"))[:40]
    # frame vertical profile: louvers and beams by name
    prof = {}
    for o in non_bulb:
        if o.name.startswith("Louver") or "Louver" in o.name:
            k = "louvers"
        elif "material_51" in o.name or "Beam" in o.name or "Post" in o.name:
            k = "beams_posts_material_51"
        else:
            continue
        lo, hi = bb(o)
        p = prof.setdefault(k, {"min_z": 9e9, "max_z": -9e9, "objects": 0})
        p["min_z"] = min(p["min_z"], lo.z)
        p["max_z"] = max(p["max_z"], hi.z)
        p["objects"] += 1
    for p in prof.values():
        p["min_z"], p["max_z"] = round(p["min_z"], 3), round(p["max_z"], 3)
    L.finish({"glb": os.path.basename(gp), "nodes_by_role": roles, "bulb_assemblies": len(bulbs), "diffuser_centre_z_min_max_m": [round(min(zs), 4), round(max(zs), 4)] if zs else None,
              "diffuser_radius_m_min_max": [round(min(rs), 4), round(max(rs), 4)] if rs else None, "bulbs_touching_or_inside_other_geometry": len(rows), "non_bulb_meshes_tested": len(bvh),
              "by_object": dict(sorted(by_obj.items(), key=lambda kv: -(kv[1]["bulbs_whose_diffuser_sphere_touches"] + kv[1]["inside_solid_for"]))[:int(L.param("top", 15))]),
              "meshes_in_columns_below_diffusers_count_of_bulbs": dict(sorted(below_by_obj.items(), key=lambda kv: -kv[1])[:int(L.param("top", 15))]),
              "first_surface_straight_up_from_centre": {k: {n: {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in e.items()} for n, e in v.items()} for k, v in firsthit.items()}, "non_bulb_surfaces_within_25cm_of_a_centre": {n: {kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in e.items()} for n, e in within25.items()}, "other_bulb_like_meshes_not_in_assemblies": other, "pergola_vertical_profile_m": prof}, save=False, examples=rows[:12])


L.run(main)
