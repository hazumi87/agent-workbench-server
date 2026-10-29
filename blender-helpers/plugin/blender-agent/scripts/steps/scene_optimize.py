"""scene_optimize — make a LIGHTER copy of a scene in a new checkpoint (the checkpoint you ran it on stays as it is): batch the static meshes by branch and material, batch the bulb fittings, reduce the static triangles to a budget, and prove that the contract still holds. Saves a checkpoint (not with dry_run). Run it on a job step you can go back to (the earlier checkpoint is the PC version).

What is batched (one new mesh per branch + material, under the same branch empty, world position unchanged): every static mesh, i.e. a mesh with no animation, no NLA track, not under a protected name, with solid colours only (a mesh that uses an image texture is left alone and reported). The branch is the ancestor `branch_depth` levels below the scene's root (default 1: the root's children, such as Structure, Furniture, Yard, Lighting); objects with the same material in the same branch become ONE mesh named `static__<branch>__<material>`. What is never touched: empties (the whole hierarchy and every anchor stay), lights, anything animated (louver blades with their clips), the bulb diffusers (each keeps its own material, so each bulb can still glow alone), and any name matching `protect`.
Bulb fittings: with `batch_fittings` true (default) the mounts, wires and sockets of all bulbs (`bulb_*.mount`, `.wire_a`, `.wire_b`, `.socket`) are merged into three meshes `fittings__mount`, `fittings__wire`, `fittings__socket` under the `Lighting` root. TRADE-OFF: after that a fitting is no longer a separate node, so moving one bulb later means rebuilding that bulb (run bulbs_make with replace on the PC checkpoint, then optimize again); the bulb empties, lights and diffusers still move freely.
Reduction: `budget_tris` is the target for the WHOLE scene. The protected triangles (diffusers, blades, anything animated) are subtracted, and the rest is shared out as a CAP on any one batched group: the heavy groups (foliage, wires) are collapse-decimated down to the cap, the light ones (walls, furniture, mounts) are left exactly as they are (never below `min_group_tris` for a group). If the budget cannot be reached the report says by how much it is missed; nothing else is cut.
params:
  budget_tris        target triangles for the scene (default 35000); 0 = batch only, no reduction
  branch_depth       1 (default): group by the root's children; 2: by their children; and so on
  protect            name globs never merged or decimated (default ["Louver_*", "Louvers_*"]); animated objects, lights, empties and `bulb_*.diffuser` are always protected
  batch_fittings     true (default) | false
  keep_separate      names / globs of static meshes to leave as their own objects (e.g. "Firepit__*")
  min_group_tris     default 60
  views              pictures of the result: "front", "iso", "top" (default ["iso"]); res px (default 640)
  dry_run            true: the plan only (groups, counts, the ratio the budget would need), nothing changes
Returns: before and after counts (triangles, mesh objects, primitives = mesh-material pairs, materials, empties, lights, animation tracks), groups (name, source objects, triangles before / after), what was left alone, and `contract`: bulbs (ids, lights, diffuser materials unique, light and bulb-anchor positions unchanged), animation (blades, tracks and clip names unchanged), hierarchy (empties and their parents), transforms of everything not merged, world bounds of the scene and per group; `problems` is empty when every check passes.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def prims(o):
    return len({p.material_index for p in o.data.polygons}) or 1


def has_image(o):
    for m in o.data.materials:
        if m and m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes):
            return True
    return False


def animated(o):
    ad = o.animation_data
    return bool(ad and (ad.action or ad.nla_tracks))


def counts(scn):
    ms = [o for o in scn.objects if o.type == "MESH"]
    return {"triangles": sum(tris(o) for o in ms), "mesh_objects": len(ms), "primitives": sum(prims(o) for o in ms), "materials_used": len({m.name for o in ms for m in o.data.materials if m}),
            "empties": sum(1 for o in scn.objects if o.type == "EMPTY"), "lights": sum(1 for o in scn.objects if o.type == "LIGHT"),
            "animation_tracks": sum(len(o.animation_data.nla_tracks) for o in scn.objects if o.animation_data)}


def contract(scn):
    bpy.context.view_layer.update()
    bulbs = sorted(o.name for o in scn.objects if o.type == "EMPTY" and o.name.startswith("bulb_") and "." not in o.name)
    lights = {o.name: (round(o.data.energy, 6), tuple(round(x, 6) for x in o.matrix_world.translation)) for o in scn.objects if o.type == "LIGHT"}
    diff = {o.name: [m.name for m in o.data.materials if m] for o in scn.objects if o.type == "MESH" and o.name.endswith(".diffuser")}
    mats = [v[0] for v in diff.values() if v]
    anchors = {n: tuple(round(x, 6) for x in scn.objects[n].matrix_world.translation) for n in bulbs}
    tracks = {o.name: sorted(t.name for t in o.animation_data.nla_tracks) for o in scn.objects if o.animation_data and o.animation_data.nla_tracks}
    empties = {o.name: (o.parent.name if o.parent else None) for o in scn.objects if o.type == "EMPTY"}
    return {"bulbs": bulbs, "lights": lights, "diffuser_materials_unique": len(set(mats)) == len(mats) and len(mats) == len(diff), "diffusers": len(diff), "anchors": anchors, "tracks": tracks, "empties": empties}


def world_bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        return None
    return [[round(min(p[i] for p in pts) * 1000, 2) for i in range(3)], [round(max(p[i] for p in pts) * 1000, 2) for i in range(3)]]


def main():
    dry = bool(L.param("dry_run", False))
    scn = bpy.context.scene
    budget = int(L.param("budget_tris", 35000))
    depth = int(L.param("branch_depth", 1))
    protect = L.param("protect", ["Louver_*", "Louvers_*"])
    keep = L.param("keep_separate", [])
    fit = bool(L.param("batch_fittings", True))
    mint = int(L.param("min_group_tris", 60))
    before = counts(scn)
    c0 = contract(scn)
    keep_xf = {o.name: np.array(o.matrix_world) for o in scn.objects}
    pat = lambda n, pl: any(fnmatch.fnmatchcase(n, p) for p in pl)  # noqa: E731

    def root_branch(o):
        chain = []
        p = o.parent
        while p is not None:
            chain.append(p)
            p = p.parent
        chain.reverse()  # root ... parent
        if len(chain) > depth:
            return chain[depth]
        return chain[-1] if chain else None

    left, groups = [], {}
    fitting_re = ("bulb_", (".mount", ".wire_a", ".wire_b", ".socket"))
    for o in sorted(scn.objects, key=lambda x: x.name):
        if o.type != "MESH":
            continue
        why = None
        if animated(o):
            why = "animated"
        elif pat(o.name, protect):
            why = "protected name"
        elif o.name.endswith(".diffuser"):
            why = "bulb diffuser (own material)"
        elif pat(o.name, keep):
            why = "keep_separate"
        elif has_image(o):
            why = "uses an image texture"
        is_fit = o.name.startswith(fitting_re[0]) and o.name.endswith(fitting_re[1])
        if is_fit and not fit:
            why = why or "batch_fittings is false"
        if why:
            left.append({"name": o.name, "why": why})
            continue
        br = root_branch(o)
        for mi in sorted({p.material_index for p in o.data.polygons}):
            mat = o.data.materials[mi] if mi < len(o.data.materials) else None
            mname = mat.name if mat else "none"
            if is_fit:
                kind = o.name.split(".")[-1].replace("wire_a", "wire").replace("wire_b", "wire")
                key = ("fittings__" + kind, scn.objects.get("Lighting") or br, mat)
            else:
                key = (f"static__{br.name if br else 'root'}__{mname}", br, mat)
            groups.setdefault(key, []).append((o, mi))
    rows = []
    protected_tris = sum(tris(o) for o in scn.objects if o.type == "MESH" and any(r["name"] == o.name and r["why"] != "keep_separate" and r["why"] != "uses an image texture" for r in left))
    static_tris = sum(sum(sum(len(p.vertices) - 2 for p in o.data.polygons if p.material_index == mi) for o, mi in lst) for lst in groups.values())
    other_tris = before["triangles"] - protected_tris - static_tris
    for (gname, br, mat), lst in groups.items():
        rows.append({"group": gname, "branch": br.name if br else None, "material": mat.name if mat else None, "objects": sorted({o.name for o, _ in lst}), "source_objects": len({o.name for o, _ in lst}),
                     "triangles_before": sum(sum(len(p.vertices) - 2 for p in o.data.polygons if p.material_index == mi) for o, mi in lst)})
    # share the static budget as a CAP on any one group (water-filling): the heavy groups (foliage, wires) are cut down to the cap, the light ones (walls, furniture) stay as they are
    cap = None
    static_budget = budget - protected_tris - other_tris
    if budget > 0 and static_tris > static_budget and rows:
        lo, hi = 0.0, float(max(r["triangles_before"] for r in rows))
        for _ in range(60):
            mid = (lo + hi) / 2
            if sum(min(r["triangles_before"], mid) for r in rows) > static_budget:
                hi = mid
            else:
                lo = mid
        cap = lo
    for r in rows:
        r["ratio"] = 1.0 if cap is None else round(max(0.02, min(1.0, cap / max(r["triangles_before"], 1))), 4)
        r["triangles_target"] = int(r["triangles_before"] * r["ratio"])
    expected = int(protected_tris + other_tris + sum(r["triangles_target"] for r in rows))
    plan = {"budget_tris": budget, "protected_triangles": protected_tris, "left_alone_triangles": other_tris, "static_triangles": static_tris, "group_cap_triangles": int(cap) if cap is not None else None,
            "expected_triangles": expected, "budget_missed_by": max(0, expected - budget) if budget else 0}
    if dry:
        L.finish({"dry_run": True, "before": before, **plan}, save=False, groups=[{**{k: v for k, v in r.items() if k != "objects"}, "objects_merged_total": len(r["objects"]), "objects_merged": r["objects"][:400]} for r in rows][:200], left_alone=left[:100], left_alone_total=len(left))
        return
    made, bounds_check = [], []
    for (gname, br, mat), lst in groups.items():
        objs = sorted({o for o, _ in lst}, key=lambda x: x.name)
        src_world = []  # the WORLD positions of exactly the faces that go into this group
        par = br
        inv = par.matrix_world.inverted() if par is not None else None
        bm = bmesh.new()
        for o, mi in lst:
            M = (inv @ o.matrix_world) if inv is not None else o.matrix_world
            me = o.data
            vmap = {}
            for p in me.polygons:
                if p.material_index != mi:
                    continue
                vs = []
                for vi in p.vertices:
                    if vi not in vmap:
                        vmap[vi] = bm.verts.new(M @ me.vertices[vi].co)
                        src_world.append(o.matrix_world @ me.vertices[vi].co)
                    vs.append(vmap[vi])
                try:
                    f = bm.faces.new(vs)
                    f.smooth = p.use_smooth
                except ValueError:
                    pass
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-7)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmw = bm.copy()  # the merged surface in WORLD space, before any reduction
        if par is not None:
            bmw.transform(par.matrix_world)
        bvh = BVHTree.FromBMesh(bmw)
        bmw.free()
        me2 = bpy.data.meshes.new(gname)
        bm.to_mesh(me2)
        bm.free()
        if mat is not None:
            me2.materials.append(mat)
        ob = bpy.data.objects.new(gname, me2)
        scn.collection.objects.link(ob)
        ob.parent = par
        if par is not None:
            ob.matrix_parent_inverse = Matrix_identity()
        ob["scene_optimize"] = True
        t_before = tris(ob)
        row_ = next(r for r in rows if r["group"] == gname and r["material"] == (mat.name if mat else None))
        ratio = row_["ratio"]
        if ratio < 0.999 and t_before > mint:
            L.activate(ob)
            mod = ob.modifiers.new("Decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = max(min(1.0, mint / t_before), ratio)
            mod.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=mod.name)
        made.append(ob)
        bpy.context.view_layer.update()
        row = next(r for r in rows if r["group"] == gname and r["material"] == (mat.name if mat else None))
        row["triangles_after"] = tris(ob)
        wv = [ob.matrix_world @ v.co for v in ob.data.vertices]
        b_before = [[min(p[i] for p in src_world) for i in range(3)], [max(p[i] for p in src_world) for i in range(3)]]
        b_after = [[min(p[i] for p in wv) for i in range(3)], [max(p[i] for p in wv) for i in range(3)]]
        row["bounds_change_mm"] = round(max(abs(a - b) for ba, bb in zip(b_before, b_after) for a, b in zip(ba, bb)) * 1000, 3)  # the group's own faces before against the group's merged mesh after
        row["world_position_error_mm"] = round(max(bvh.find_nearest(p)[3] for p in src_world) * 1000, 4)  # every source vertex against the merged surface: ~0 means the geometry stayed where it was
        dev = [bvh.find_nearest(p)[3] for p in wv]
        row["surface_deviation_mm"] = {"max": round(max(dev) * 1000, 3), "mean": round(sum(dev) / len(dev) * 1000, 3)}  # the reduced mesh's vertices against the unreduced merged surface
    # remove the originals (and their orphaned meshes): only objects every material of which went into a group
    gone = set()
    for lst in groups.values():
        for o, _ in lst:
            gone.add(o.name)
    for nm in sorted(gone):
        o = bpy.data.objects.get(nm)
        if o is None:
            continue
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.meshes.remove(data)
    bpy.context.view_layer.update()
    after = counts(scn)
    c1 = contract(scn)
    problems = []
    if c0["bulbs"] != c1["bulbs"]:
        problems.append("bulb anchors changed")
    if c0["lights"] != c1["lights"]:
        problems.append("lights (count, energy or position) changed")
    if not c1["diffuser_materials_unique"] or c0["diffusers"] != c1["diffusers"]:
        problems.append("diffuser materials are no longer one per bulb")
    if c0["anchors"] != c1["anchors"]:
        problems.append("a bulb anchor moved")
    if c0["tracks"] != c1["tracks"]:
        problems.append("animation tracks changed")
    if c0["empties"] != c1["empties"]:
        problems.append("the empties or their parents changed")
    moved = []
    for nm, mw in keep_xf.items():
        o = bpy.data.objects.get(nm)
        if o is not None and np.abs(np.array(o.matrix_world) - mw).max() > 1e-6:
            moved.append(nm)
    if moved:
        problems.append(f"{len(moved)} untouched objects moved, e.g. {moved[:3]}")
    if budget and after["triangles"] > budget:
        problems.append(f"budget missed: {after['triangles']} triangles against {budget}")
    files = []
    if L.param("views", ["iso"]):
        allm = [o for o in scn.objects if o.type == "MESH"]
        lo_hi = world_bounds(allm)
        ctr = Vector([(a + b) / 2000 for a, b in zip(*lo_hi)])
        size = max(b - a for a, b in zip(*lo_hi)) / 1000 * 1.3
        dirs = {"iso": (0.6, -0.8, 0.5), "front": (0, -1, 0.05), "top": (0, 0, 1)}
        files = HV.render_views(allm, ctr, size, "optimize", res=int(L.param("res", 640)), dirs={v: dirs[v] for v in L.param("views", ["iso"]) if v in dirs})
    contract_out = {"bulbs": len(c1["bulbs"]), "lights": len(c1["lights"]), "diffusers": c1["diffusers"], "diffuser_materials_unique": c1["diffuser_materials_unique"], "bulb_anchors_unchanged": c0["anchors"] == c1["anchors"],
                    "light_energy_and_position_unchanged": c0["lights"] == c1["lights"], "animation_tracks_unchanged": c0["tracks"] == c1["tracks"], "tracks_listed": {k: v for k, v in list(c1["tracks"].items())[:6]},
                    "empties_and_parents_unchanged": c0["empties"] == c1["empties"], "untouched_objects_moved": len(moved), "scene_bounds_mm_after": world_bounds([o for o in scn.objects if o.type == "MESH"]),
                    "max_group_bounds_change_mm": max([r.get("bounds_change_mm", 0) for r in rows] or [0]), "max_world_position_error_mm": max([r.get("world_position_error_mm", 0) for r in rows] or [0]),
                    "max_surface_deviation_mm": max([r.get("surface_deviation_mm", {}).get("max", 0) for r in rows] or [0])}
    L.finish({"dry_run": False, "before": before, "after": after, **plan, "problems": problems}, save=True, files=files, groups=[{**{k: v for k, v in r.items() if k != "objects"}, "objects_merged_total": len(r["objects"]), "objects_merged": r["objects"][:400]} for r in rows][:200], left_alone=left[:100], left_alone_total=len(left), contract=contract_out,
             pictures=[os.path.basename(f) for f in files])


def Matrix_identity():
    from mathutils import Matrix
    return Matrix.Identity(4)


L.run(main)
