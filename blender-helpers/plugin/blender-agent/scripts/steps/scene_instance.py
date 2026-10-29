"""scene_instance — make COPIES of objects (a textured foliage card, a crossed pair, a whole tree group) placed, turned and SCALED ABOUT THEIR OWN BASE, to widen or densify a row without touching anything that exists. Saves a checkpoint (not with dry_run).
The copies share the source's mesh and materials by default (`linked`: true; the export writes shared meshes once), keep every texture and alpha setting, and keep the hierarchy among themselves. The originals are never moved, renamed or changed.
params:
  copies  list of {
            "source": "tree_card_01" | ["card_a", "card_b"]   one object or a group; a source with children brings its whole subtree; a LIST is one group (one base point, copies named <name>_<n>),
            "name": "conifer_new_01"                           name of the new root (a group copy: the prefix); it must not exist,
            "at": [x, y, z]  OR  "move": [dx, dy, dz]          where the BASE POINT ends up (world), or how far it moves from where it is (default: the same place),
            "scale": 1.3 | [sxy, sxy, sz]                      uniform, or one horizontal factor (x = y) and a height factor; about the base point; non-uniform with x != y is refused,
            "rotate_deg": 0 | [rx, ry, rz]                     degrees: a number = about the world Z axis; a list = about the world X, Y, Z axes (that order) through the base point (applied before the scale and move),
            "about": "base" (default) | "origin" | [x, y, z]   the base point: the middle of the lowest face of the group's world bounding box, the source root's origin, or a world point,
            "linked": true,                                    false = own copies of the meshes (needed to edit a copy's geometry later),
            "parent": "Yard" (optional)                        put the copy under this object (its world position is kept)
          }
  dry_run true: compute and report, create nothing
Returns per copy: objects created, the base point, scale, rotation, the new world bounding box (min / max, m) and the source's, the shared meshes count, and a check that no source object moved.
"""
import fnmatch  # noqa: F401
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def subtree(o):
    return [o] + list(o.children_recursive)


def bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == "MESH" for c in o.bound_box]
    if not pts:
        pts = [o.matrix_world.translation for o in objs]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def main():
    dry = bool(L.param("dry_run", False))
    bpy.context.view_layer.update()
    scn = bpy.context.scene
    before = {o.name: np.array(o.matrix_world).copy() for o in scn.objects}
    report = []
    for spec in L.param("copies") or []:
        src_names = spec["source"] if isinstance(spec["source"], list) else [spec["source"]]
        group = isinstance(spec["source"], list)
        roots = []
        for n in src_names:
            o = bpy.data.objects.get(n)
            if o is None:
                raise RuntimeError(f"source {n!r}: no such object")
            roots.append(o)
        objs = []
        for r in roots:
            for o in subtree(r):
                if o not in objs:
                    objs.append(o)
        name = spec["name"]
        if bpy.data.objects.get(name) is not None or any(bpy.data.objects.get(f"{name}_{i + 1}") for i in range(len(roots)) if group):
            raise RuntimeError(f"{name!r} already exists: copies never replace an object")
        lo, hi = bbox(objs)
        about = spec.get("about", "base")
        if about == "base":
            P = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
        elif about == "origin":
            P = roots[0].matrix_world.translation.copy()
        else:
            P = Vector(about)
        sc = spec.get("scale", 1.0)
        if isinstance(sc, (int, float)):
            sxy = sz = float(sc)
        else:
            sxy, sy_, sz = [float(x) for x in sc]
            if abs(sxy - sy_) > 1e-9:
                raise RuntimeError("scale [sx, sy, sz]: sx must equal sy (one horizontal factor, one height factor)")
        rd = spec.get("rotate_deg", 0.0)
        if isinstance(rd, (list, tuple)):  # [rx, ry, rz] degrees about the WORLD X, Y, Z axes through the base point (X, then Y, then Z), as in scene_tree; a plain number = about Z
            rx, ry, rz = [math.radians(float(x)) for x in rd]
            R = Matrix.Rotation(rz, 4, "Z") @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rx, 4, "X")
        else:
            R = Matrix.Rotation(math.radians(float(rd)), 4, "Z")
        if "at" in spec:
            P2 = Vector(spec["at"])
        else:
            P2 = P + Vector(spec.get("move", [0, 0, 0]))
        A = Matrix.Translation(P2) @ R @ Matrix.Diagonal((sxy, sxy, sz, 1.0)) @ Matrix.Translation(-P)
        row = {"source": spec["source"], "name": name, "objects": len(objs), "base_point_m": [round(x, 4) for x in P], "base_after_m": [round(x, 4) for x in P2], "scale_xy": sxy, "scale_z": sz,
               "rotate_deg": rd, "linked": bool(spec.get("linked", True)), "source_bbox_m": [[round(x, 4) for x in lo], [round(x, 4) for x in hi]]}
        # the new bounding box without creating anything
        pts = [A @ (o.matrix_world @ Vector(c)) for o in objs if o.type == "MESH" for c in o.bound_box]
        if pts:
            nlo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
            nhi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
            row["new_bbox_m"] = [[round(x, 4) for x in nlo], [round(x, 4) for x in nhi]]
            row["new_size_m"] = [round(x, 4) for x in (nhi - nlo)]
        if spec.get("parent") and bpy.data.objects.get(spec["parent"]) is None:
            raise RuntimeError(f"parent {spec['parent']!r}: no such object (nothing was created)")
        if dry:
            report.append(row)
            continue
        mapping = {}
        for i, r in enumerate(roots):
            for o in subtree(r):
                c = o.copy()
                if o.data is not None and not spec.get("linked", True):
                    c.data = o.data.copy()
                suffix = f"_{i + 1}" if group else ""
                c.name = (name + suffix) if o is r else f"{name}{suffix}.{o.name}"
                mapping[o] = c
                cols = list(o.users_collection) or [scn.collection]
                cols[0].objects.link(c)
        parent = bpy.data.objects.get(spec["parent"]) if spec.get("parent") else None
        if spec.get("parent") and parent is None:
            raise RuntimeError(f"parent {spec['parent']!r}: no such object (nothing was created for this copy)")
        for o, c in mapping.items():
            c.parent = mapping.get(o.parent)  # inside the group: the copy's own parent; a group root: none for now
            c.matrix_parent_inverse = Matrix.Identity(4)
        bpy.context.view_layer.update()
        # world matrices from the originals (not from the parents): set roots first, then children follow their parents
        for o in sorted(mapping, key=lambda x: len(list(_anc(x)))):
            c = mapping[o]
            c.matrix_world = A @ o.matrix_world
            bpy.context.view_layer.update()
        if parent is not None:
            for r in roots:
                c = mapping[r]
                mw = c.matrix_world.copy()
                c.parent = parent
                c.matrix_parent_inverse = parent.matrix_world.inverted()
                c.matrix_world = mw
        bpy.context.view_layer.update()
        row["objects_created"] = len(mapping)
        row["roots"] = [mapping[r].name for r in roots]
        row["meshes_shared_with_source"] = sum(1 for o, c in mapping.items() if o.data is not None and c.data is o.data)
        nl, nh = bbox([mapping[o] for o in mapping])
        row["created_bbox_m"] = [[round(x, 4) for x in nl], [round(x, 4) for x in nh]]
        report.append(row)
    moved = [n for n, m in before.items() if n in bpy.data.objects and np.abs(np.array(bpy.data.objects[n].matrix_world) - m).max() > 1e-6]
    L.finish({"dry_run": dry, "copies": len(report), "originals_moved": moved[:10], "originals_moved_count": len(moved)}, save=not dry, rows=report)


def _anc(o):
    while o.parent is not None:
        o = o.parent
        yield o


L.run(main)
