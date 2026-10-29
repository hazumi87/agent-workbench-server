"""scene_tree — make named EMPTIES (the roots and groups of a scene: Structure, Furniture, Lighting ...) and put objects under them, keeping every world position. Saves a checkpoint (not with dry_run).

Real parent/child nodes survive a GLB export (export_scene), so a runtime can find "Lighting" and each part below it by name.
Frame: the scene's world frame (Z up, metres); `units` "m" (default) or "mm" for every number you give.
params:
  empties   list of {"name": "Structure", "parent": "Scene" (optional: another empty or object), "at": [x, y, z] (default the origin), "display": "PLAIN_AXES" (default) | "ARROWS" | "CUBE" | "SPHERE", "size": 0.2}
            a name that already exists as an empty this verb made is left as it is (and moved to a new parent / position when those differ); an existing object that is not such an empty is never replaced (refused)
  parent    list of {"child": "struct_wall_*" (a name or a glob), "to": "Structure"}: each matching object goes under `to`, its world transform unchanged; objects that are already under it are skipped; a name that matches nothing is reported
  unparent  names of objects to take out of their parent (world transform unchanged)
  origins   list of {"objects": "louver_*" (a name or a glob), "at": "centre" (default: the middle of each object's bounding box) | [x, y, z] (a world point)}: move each mesh's ORIGIN (its pivot) to that point WITHOUT moving its geometry: the vertices are shifted the opposite way, so the world shape is identical (the report shows the largest change of any bounding-box corner, in mm, and the object's longest axis: the axis a blade turns about when rotated about that local axis). Objects with a rotation or scale keep them; an object whose mesh is shared with another is refused unless the entry has `"single_user": true`, which first gives each matched object its own copy of the mesh (materials and UVs kept; the other users keep the original; the report marks `made_single_user`).
  transform list of {"objects": "Site" (a name or a glob: an EMPTY, a mesh, any object), "rotate_deg": [rx, ry, rz] (about the WORLD X, Y, Z axes, applied X then Y then Z), "about": [x, y, z] (a world point; default the object's own origin), "move_mm": [dx, dy, dz] (world)}: a rigid turn and / or move of the object and EVERYTHING BELOW IT as one: the object's world matrix is replaced by the turned one, so its children keep their own local transforms, meshes are not rewritten and every pivot stays where it was relative to its parent. Runs after `parent`, so a group of objects is first put under an empty, then turned. Order: rotate, then move. An object whose ancestor is also matched is skipped (it would turn twice). The report gives, for each, the origin before and after, the number of descendants, and `descendant_local_change` (the largest change of any descendant's own local matrix: 0 = rigid). Scale is not offered: it would change meshes' proportions.
  rename    {"rules": [{"find": "Louver_A_", "replace": "Louver_B_"}, {"find": "Louver_B_", "replace": "Louver_A_"}], "what": ["objects", "data", "actions", "nla_tracks"] (default; also "materials", "lights")}: a COLLISION-SAFE rename, a swap included. Every name is rewritten in ONE pass from its ORIGINAL text (all the `find` strings at once, so A->B and B->A do not chain), the final names are checked (a name longer than 63 characters, or two things ending up with the same name, or a new name already used by something that is not renamed, refuses the whole rename and changes nothing), and then everything is renamed in two phases through temporary names. Only names change: geometry, transforms, parents, materials, actions on their objects and NLA strips stay bound (Blender keeps the references). `what`: objects (and empties, lights), data (mesh / light data blocks), actions, nla_tracks (the track names, which become the glTF animation names), materials, lights (light data). The report lists the old -> new mapping per kind.
  drop_factory  true: remove the factory objects named exactly Cube, Light and Camera that are still in the job (a job whose first step was made before this verb existed keeps them; they would be exported). Only those three names are touched, and the report lists them.
  dry_run   true: nothing changes; the report says what would happen
Returns: created, moved, parented, skipped, refused, unmatched, and the tree (indented text and a nested list) after the call.
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import math  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def tree_text(roots):
    lines = []

    def walk(o, d):
        lines.append("  " * d + o.name + (f" [{o.type.lower()}]" if o.type != "EMPTY" else ""))
        for c in sorted(o.children, key=lambda x: x.name):
            walk(c, d + 1)
    for r in sorted(roots, key=lambda x: x.name):
        walk(r, 0)
    return lines


def set_parent(child, parent):
    bpy.context.view_layer.update()  # a freshly made or moved object has no up-to-date world matrix until the layer is updated: without this the child would be put back at the origin
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = mw


def main():
    k = 0.001 if L.param("units", "m") == "mm" else 1.0
    dry = bool(L.param("dry_run", False))
    scn = bpy.context.scene
    factory_removed = L.drop_factory_objects() if not L.param('dry_run', False) else []
    rep = {"created": [], "moved": [], "parented": [], "skipped": [], "refused": [], "unmatched": []}
    made = lambda o: o is not None and o.type == "EMPTY" and "scene_tree_made" in o  # noqa: E731
    dropped = []
    if L.param("drop_factory", False):
        for on in ("Cube", "Light", "Camera"):
            o = bpy.data.objects.get(on)
            if o is not None and "scene_tree_made" not in o:
                dropped.append(on)
                if not dry:
                    bpy.data.objects.remove(o, do_unlink=True)
    pending = {}  # dry run: empties that would exist
    for e in L.param("empties") or []:
        nm = e["name"]
        ex = bpy.data.objects.get(nm)
        if ex is not None and not made(ex):
            rep["refused"].append({"name": nm, "why": "an object of that name exists and was not made by scene_tree"})
            continue
        par = bpy.data.objects.get(e["parent"]) if e.get("parent") else None
        if e.get("parent") and par is None and e["parent"] not in pending:
            rep["refused"].append({"name": nm, "why": f"parent {e['parent']} does not exist"})
            continue
        at = Vector([float(x) * k for x in e.get("at", [0, 0, 0])])
        if ex is None:
            rep["created"].append({"name": nm, "parent": e.get("parent"), "at_m": [round(x, 4) for x in at]})
            pending[nm] = True
            if dry:
                continue
            o = bpy.data.objects.new(nm, None)
            o.empty_display_type = e.get("display", "PLAIN_AXES")
            o.empty_display_size = float(e.get("size", 0.2))
            o["scene_tree_made"] = True
            scn.collection.objects.link(o)
            o.location = at
            bpy.context.view_layer.update()
            if par is not None:
                set_parent(o, par)
        else:
            changed = (ex.parent.name if ex.parent else None) != e.get("parent") or (ex.matrix_world.translation - at).length > 1e-6 and "at" in e
            if changed:
                rep["moved"].append({"name": nm, "parent": e.get("parent")})
                if not dry:
                    kids = {c: c.matrix_world.copy() for c in ex.children}  # the children stay where they are in the world when their parent empty is moved
                    if "at" in e:
                        ex.parent = None
                        mw = ex.matrix_world.copy()
                        mw.translation = at
                        ex.matrix_world = mw
                    if par is not None:
                        set_parent(ex, par)
                    bpy.context.view_layer.update()
                    for c, m in kids.items():
                        c.matrix_world = m
            else:
                rep["skipped"].append(nm)
    for pr in L.param("parent") or []:
        to = bpy.data.objects.get(pr["to"])
        if to is None and pr["to"] not in pending:
            rep["unmatched"].append({"child": pr["child"], "why": f"{pr['to']} does not exist"})
            continue
        hits = [o for o in bpy.data.objects if fnmatch.fnmatchcase(o.name, pr["child"]) and o is not to]
        if not hits:
            rep["unmatched"].append({"child": pr["child"], "why": "matched nothing"})
        for o in hits:
            if to is not None and o.parent is to:
                rep["skipped"].append(o.name)
                continue
            if to is not None:
                p = to
                while p is not None:
                    if p is o:
                        rep["refused"].append({"name": o.name, "why": f"{pr['to']} is below {o.name}: that would make a loop"})
                        break
                    p = p.parent
                else:
                    rep["parented"].append({"name": o.name, "to": pr["to"]})
                    if not dry:
                        set_parent(o, to)
            else:
                rep["parented"].append({"name": o.name, "to": pr["to"]})
    transform_rows = []
    for tf in L.param("transform") or []:
        hits = [o for o in bpy.data.objects if fnmatch.fnmatchcase(o.name, tf["objects"])]
        if not hits:
            rep["unmatched"].append({"child": tf["objects"], "why": "transform: matched no object"})
            continue
        names = {o.name for o in hits}
        for o in hits:
            anc, p = False, o.parent
            while p is not None:
                if p.name in names:
                    anc = True
                    break
                p = p.parent
            if anc:
                rep["skipped"].append(o.name)
                continue
            bpy.context.view_layer.update()
            kids = list(o.children_recursive)
            loc_before = {c.name: c.matrix_local.copy() for c in kids}
            w0 = o.matrix_world.copy()
            pv = Vector([float(x) * k for x in tf["about"]]) if "about" in tf else w0.translation.copy()
            rx, ry, rz = [math.radians(float(a)) for a in tf.get("rotate_deg", [0, 0, 0])]
            R = (Euler((rx, ry, rz), "XYZ")).to_matrix().to_4x4()
            M = Matrix.Translation(pv) @ R @ Matrix.Translation(-pv)
            if "move_mm" in tf:
                M = Matrix.Translation(Vector([float(x) * 0.001 for x in tf["move_mm"]])) @ M
            row = {"name": o.name, "origin_before_m": [round(x, 4) for x in w0.translation], "descendants": len(kids)}
            if not dry:
                o.matrix_world = M @ w0
                bpy.context.view_layer.update()
                row["origin_after_m"] = [round(x, 4) for x in o.matrix_world.translation]
                row["descendant_local_change"] = round(max([max(abs(a - b) for ra, rb in zip(c.matrix_local, loc_before[c.name]) for a, b in zip(ra, rb)) for c in kids] or [0.0]), 8)
            else:
                row["origin_after_m"] = [round(x, 4) for x in (M @ w0).translation]
            transform_rows.append(row)
    rename_rows = {}
    rn = L.param("rename")
    if rn:
        import re
        rules = {r["find"]: r["replace"] for r in rn["rules"]}
        pat = re.compile("|".join(re.escape(f) for f in sorted(rules, key=len, reverse=True)))
        what = rn.get("what", ["objects", "data", "actions", "nla_tracks"])
        sources = {"objects": [(o, "name") for o in bpy.data.objects], "data": [(m, "name") for m in list(bpy.data.meshes) + list(bpy.data.lights)], "actions": [(a, "name") for a in bpy.data.actions],
                   "materials": [(m, "name") for m in bpy.data.materials], "nla_tracks": [(t, "name") for o in bpy.data.objects if o.animation_data for t in o.animation_data.nla_tracks]}
        sources["lights"] = [(m, "name") for m in bpy.data.lights]
        problems = []
        plan_r = {}
        for kind in what:
            if kind not in sources:
                problems.append(f"unknown `what`: {kind}")
                continue
            items = sources[kind]
            pairs = [(ob, ob.name, pat.sub(lambda m_: rules[m_.group(0)], ob.name)) for ob, _ in items]
            changed = [(ob, a, b) for ob, a, b in pairs if a != b]
            finals = [b for _, _, b in pairs] if kind != "nla_tracks" else None
            if finals is not None:
                dup = {n for n in finals if finals.count(n) > 1}
                if dup:
                    problems.append(f"{kind}: two items would be named the same: {sorted(dup)[:5]}")
            long_ = [b for _, _, b in changed if len(b) > 63]
            if long_:
                problems.append(f"{kind}: name longer than 63 characters: {long_[0]}")
            if kind == "nla_tracks":  # a track name must be unique only on its own object
                per = {}
                for ob, a, b in pairs:
                    per.setdefault(ob.id_data if hasattr(ob, "id_data") else None, []).append(b)
            plan_r[kind] = changed
            rename_rows[kind] = [{"from": a, "to": b} for _, a, b in changed][:400]
        if problems:
            rep["refused"].append({"name": "rename", "why": "; ".join(problems)})
            plan_r = {}
            rename_rows = {}
        elif not dry:
            for kind, changed in plan_r.items():
                if kind == "nla_tracks":
                    for ob, a, b in changed:
                        ob.name = b
                    continue
                for i, (ob, a, b) in enumerate(changed):
                    ob.name = f"__rn_{kind}_{i}"
                for ob, a, b in changed:
                    ob.name = b
    origin_rows = []
    for og in L.param("origins") or []:
        hits = [o for o in bpy.data.objects if o.type == "MESH" and fnmatch.fnmatchcase(o.name, og["objects"])]
        if not hits:
            rep["unmatched"].append({"child": og["objects"], "why": "origins: matched no mesh"})
        for o in hits:
            made_single = False
            if o.data.users > 1 and og.get("single_user"):
                made_single = True
                if not dry:
                    o.data = o.data.copy()  # this object gets its own copy of the mesh (materials, UVs and every other object unchanged)
            elif o.data.users > 1:
                rep["refused"].append({"name": o.name, "why": "its mesh is shared with another object"})
                continue
            before = [o.matrix_world @ Vector(c) for c in o.bound_box]
            ext = [max(v[i] for v in before) - min(v[i] for v in before) for i in range(3)]
            P = (sum(before, Vector()) / 8.0) if og.get("at", "centre") == "centre" else Vector([float(x) * k for x in og["at"]])
            row = {"name": o.name, "origin_before_m": [round(x, 4) for x in o.matrix_world.translation], "origin_after_m": [round(x, 4) for x in P], "longest_axis": "XYZ"[ext.index(max(ext))], "length_m": round(max(ext), 4)}
            if made_single:
                row["made_single_user"] = True
            if not dry:
                dl = o.matrix_world.inverted().to_3x3() @ (P - o.matrix_world.translation)
                o.data.transform(Matrix.Translation(-dl))
                mw = o.matrix_world.copy()
                mw.translation = P
                o.matrix_world = mw
                bpy.context.view_layer.update()
                after = [o.matrix_world @ Vector(c) for c in o.bound_box]
                row["max_corner_change_mm"] = round(max((a - b).length for a, b in zip(before, after)) * 1000, 4)
            origin_rows.append(row)
    for nm in L.param("unparent") or []:
        o = bpy.data.objects.get(nm)
        if o is None:
            rep["unmatched"].append({"child": nm, "why": "no such object"})
        elif o.parent is not None:
            rep["moved"].append({"name": nm, "parent": None})
            if not dry:
                mw = o.matrix_world.copy()
                o.parent = None
                o.matrix_world = mw
    roots = [o for o in scn.objects if o.parent is None and ("scene_tree_made" in o or o.children)]
    text = tree_text(roots)
    L.finish({"dry_run": dry, **{k_: len(v) for k_, v in rep.items()}}, save=not dry, **rep, factory_removed=factory_removed + dropped, origins=origin_rows[:200], origins_total=len(origin_rows), transformed=transform_rows[:100], renamed=rename_rows, tree=text[:400], tree_total_lines=len(text))


L.run(main)
