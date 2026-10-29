"""scene_ray — WHICH object / face is where: fire rays through the WHOLE working scene and list every surface they cross, nearest first. Reads only; nothing is changed or saved.

For a mystery in a picture (a black rectangle at a window corner): give the camera position and the world point you see it at, and read which object, face, side (front or back), material and colour is hit first and what lies behind it. Hits are on the geometry only: a material's alpha / cut-out is NOT considered (a card with transparent parts still counts as a hit there), and objects hidden in the viewport are not hit.
params:
  rays    list of {"name": "corner0",
                   "from": [x, y, z]   metres, world frame (Z up),
                   then ONE of "to": [x, y, z]  (the ray runs from `from` through this point and on) OR "dir": [dx, dy, dz],
                   "limit": 8 (how many surfaces to list), "max_m": 100}
  or, to aim at a NAMED object: {"name": "cap0", "at_object": "Frame_Corner0", "dirs": [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,-1]], "back_m": 2.0}: one ray per direction, each starting `back_m` metres BEHIND the middle of the object's bounding box (so it travels along the direction through the object's middle); a way to probe a spot without knowing the camera.
  grids   list of {"name": "head_left", "at_object": "Frame_Corner0", "dir": [0, -1, 0], "half_m": 0.08, "n": 9, "back_m": 1.5}: an n x n grid of PARALLEL rays along `dir`, covering a square of 2 x `half_m` metres across the plane through the middle of the object's bounding box (u = the grid's right, v = up (or the other horizontal axis for a vertical dir)). Returns `map`: n rows (top row first) of one-letter codes for the FIRST surface each ray hits, a `legend` (letter -> object, side, material) and the u / v coordinates in metres: a quick picture of what is visible in that patch, so a hole shows up as the letter of whatever lies behind it.
  radius_mm  default 0: with a number, each ray also reports the objects hit by a small fan of 8 extra rays on a circle of that radius around the pointed place (at `to`'s distance), so a thin gap or an edge is not missed.
Returns per ray `hits` (nearest first): object, parent, face (polygon index), distance_m, hit_m, face_normal (world), `side` ("front": the ray meets the face's visible side, "back": it meets the back of the face: such a face renders dark with one-sided shading or disappears with culling), face_area_m2, face_corners_m (up to 8), material (slot name), base_colour (the Principled Base Colour, or the material's viewport colour), hide_render, collection names; plus `fan_objects` when radius_mm is given.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def base_colour(mat):
    if mat is None:
        return None
    if mat.use_nodes:
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                c = n.inputs["Base Color"].default_value
                linked = n.inputs["Base Color"].is_linked
                return {"rgba_linear": [round(c[i], 3) for i in range(4)], "texture_linked": bool(linked)}
    return {"viewport_rgba": [round(mat.diffuse_color[i], 3) for i in range(4)]}


def cast_all(scn, dg, o, d, limit, max_m):
    hits = []
    org = Vector(o)
    for _ in range(limit):
        ok, loc, nrm, idx, ob, mw = scn.ray_cast(dg, org, d, distance=max_m)
        if not ok:
            break
        hits.append((loc.copy(), nrm.copy(), idx, ob))
        org = loc + d * 1e-4
        max_m = max(max_m - (loc - Vector(o)).length, 0.0) if False else max_m
    return hits


def main():
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    rays = []
    for r in L.param("rays") or []:
        if "at_object" in r:
            ob = bpy.data.objects.get(r["at_object"])
            if ob is None:
                raise RuntimeError(f"at_object: no object named {r['at_object']!r}")
            pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
            mid = sum(pts, Vector()) / 8.0
            for dd in r.get("dirs") or [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, -1]]:
                dv = Vector(dd).normalized()
                rays.append({"name": f"{r.get('name', r['at_object'])}_dir{[round(x, 2) for x in dv]}", "from": list(mid - dv * float(r.get("back_m", 2.0))), "dir": list(dv),
                             "limit": r.get("limit", 8), "max_m": r.get("max_m", 100)})
        else:
            rays.append(r)
    grids_out = []
    for g in L.param("grids") or []:
        ob = bpy.data.objects.get(g["at_object"])
        if ob is None:
            raise RuntimeError(f"grids: no object named {g['at_object']!r}")
        pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        mid = sum(pts, Vector()) / 8.0
        d = Vector(g.get("dir", [0, -1, 0])).normalized()
        up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, 1, 0))
        u = d.cross(up).normalized()
        v = u.cross(d).normalized()
        n = int(g.get("n", 9))
        half = float(g.get("half_m", 0.08))
        back = float(g.get("back_m", 1.5))
        legend, letters, rows, extra = {}, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", [], {}
        for iv in range(n):
            row = ""
            vv = half - 2 * half * iv / max(n - 1, 1)
            for iu in range(n):
                uu = -half + 2 * half * iu / max(n - 1, 1)
                org = mid + u * uu + v * vv - d * back
                ok, loc, nrm, idx, ob2, mw = scn.ray_cast(dg, org, d, distance=100.0)
                if not ok:
                    row += "."
                    continue
                me2 = ob2.data
                poly = me2.polygons[idx]
                mat = me2.materials[poly.material_index] if poly.material_index < len(me2.materials) else None
                side = "front" if (mw.to_3x3() @ poly.normal).dot(d) < 0 else "BACK"
                key = (ob2.name, side, mat.name if mat else None)
                if key not in legend:
                    legend[key] = letters[len(legend) % 26]
                    extra[key] = {"first_hit_m": [round(x, 4) for x in loc], "base_colour": base_colour(mat), "parent": ob2.parent.name if ob2.parent else None, "collections": [c.name for c in ob2.users_collection]}
                row += legend[key]
            rows.append(row)
        grids_out.append({"name": g.get("name"), "centre_m": [round(x, 4) for x in mid], "dir": [round(x, 3) for x in d], "u_axis": [round(x, 3) for x in u], "v_axis": [round(x, 3) for x in v],
                          "half_m": half, "n": n, "map": rows, "legend": {l: dict({"object": k[0], "side": k[1], "material": k[2]}, **extra[k]) for k, l in legend.items()}})
    for r in rays:
        o = Vector(r["from"])
        if "to" in r:
            d = (Vector(r["to"]) - o)
            target_dist = d.length
            d = d.normalized()
        elif "dir" in r:
            d = Vector(r["dir"]).normalized()
            target_dist = None
        else:
            raise RuntimeError(f"{r.get('name')}: give 'to' or 'dir'")
        lim = int(r.get("limit", 8))
        rows = []
        for loc, nrm, idx, ob in cast_all(scn, dg, o, d, lim, float(r.get("max_m", 100))):
            me = ob.data
            poly = me.polygons[idx]
            mat = me.materials[poly.material_index] if poly.material_index < len(me.materials) else None
            mw = ob.matrix_world
            corners = [(mw @ me.vertices[v].co) for v in poly.vertices][:8]
            wn = (mw.to_3x3() @ poly.normal).normalized()
            rows.append({"object": ob.name, "parent": ob.parent.name if ob.parent else None, "face": idx, "distance_m": round((loc - o).length, 4),
                         "hit_m": [round(x, 4) for x in loc], "face_normal": [round(x, 3) for x in wn],
                         "side": "front" if wn.dot(d) < 0 else "back", "face_area_m2": round(poly.area * abs(mw.determinant()) ** (2 / 3), 5),
                         "face_corners_m": [[round(x, 4) for x in c] for c in corners],
                         "material": mat.name if mat else None, "base_colour": base_colour(mat), "hide_render": bool(ob.hide_render),
                         "collections": [c.name for c in ob.users_collection]})
        row = {"name": r.get("name"), "from": [round(x, 4) for x in o], "dir": [round(x, 4) for x in d], "hits": rows}
        rad = float(L.param("radius_mm", 0)) * 0.001
        if rad > 0 and target_dist:
            up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
            u = d.cross(up).normalized()
            v = d.cross(u).normalized()
            tgt = o + d * target_dist
            names = {}
            for j in range(8):
                a = 2 * math.pi * j / 8
                p = tgt + (u * math.cos(a) + v * math.sin(a)) * rad
                d2 = (p - o).normalized()
                ok, loc, nrm, idx, ob, mw = scn.ray_cast(dg, o, d2, distance=100.0)
                if ok:
                    names[ob.name] = names.get(ob.name, 0) + 1
            row["fan_first_hit_objects"] = names
        out.append(row)
    L.finish({"rays": len(out), "notes": ["geometry only: material alpha / cut-outs are ignored; viewport-hidden objects are not hit"]}, save=False, rays_out=out, grids_out=grids_out)


L.run(main)
