"""scene_append — append a GLB/glTF/FBX/OBJ file's whole hierarchy to the scene under ONE named root empty, then scale / turn / move that root. Saves a checkpoint (not with dry_run).

The first step of a fresh job may be scene_append (the factory Cube/Light/Camera are removed); later calls add more files to the same scene. Imported materials, textures, node pivots and the node tree are kept: nothing is merged or applied, so every object keeps its own origin and its place under its parent. All the file's top-level objects go under the root; the root carries the transform, so one uniform scale and one rigid move fit the whole file.
Frame: the scene's world frame (Z up, metres). glTF Y-up files are converted by the importer.
params:
  src         path to the file (absolute, or relative to the tool root)   [required]
  root        name of the root empty to make (e.g. "Site", "Frame")   [required]; refused when an object of that name already exists
  prefix      text put in front of every imported object's name (default: none; names that already exist get Blender's .001 suffix, so use a prefix when two files may share names, e.g. "site_")
  scale       uniform scale of the root (default 1)
  scale_to    {"axis": "x"|"y"|"z", "length_m": 2.0, "of": "Frame_*" (optional)}: instead of `scale`, scale the root so a world bounding box is `length_m` long along that axis, measured before the scale. Default box: all imported meshes (a file that also holds a house or yard measures that too); `of` = an imported object name or glob (with the prefix): the box of the matches and everything below them. `scale` and `scale_to` together are refused
  rotate_deg  [rx, ry, rz] about the WORLD X, Y, Z axes through the root's `about` point, applied X then Y then Z (default none)
  about       [x, y, z] world point the root is scaled and turned about (default the origin)
  move_m      [dx, dy, dz] world move of the root, after the scale and turn (default none)
  dry_run     true: import and measure, change nothing saved
Returns: root, `imported` (object count by type), `top_level` (names put under the root), `bbox_before` / `bbox_after` (world min, max and size in m of the imported meshes), `scale_used`, `materials` (count), `tris`.
Scale is on the ROOT only; to bake a scale into meshes use a later step. Each imported file's animations come along (actions are kept, names prefixed).
"""
import fnmatch
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def bbox(objs):
    pts = []
    for o in objs:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        pts += [mw @ Vector(c) for c in o.bound_box]
    if not pts:
        return None
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    r = lambda v: [round(x, 4) for x in v]  # noqa: E731
    return {"min": r(lo), "max": r(hi), "size": r(hi - lo)}


def main():
    src = L.resolve(L.param("src"), what="src")
    if not os.path.isfile(src):
        raise FileNotFoundError(src)
    root_name = L.param("root")
    if not root_name:
        raise RuntimeError("root: give the name of the root empty")
    if bpy.data.objects.get(root_name) is not None:
        raise RuntimeError(f"root: an object named {root_name!r} already exists")
    sc, sct = L.param("scale"), L.param("scale_to")
    if sc is not None and sct:
        raise RuntimeError("scale and scale_to together are refused: give one")
    dry = bool(L.param("dry_run", False))
    L.drop_factory_objects()
    before = set(bpy.data.objects)
    mats_before = set(bpy.data.materials)
    ext = os.path.splitext(src)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    else:
        raise ValueError(f"unsupported format: {ext}")
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        raise RuntimeError("the file brought no objects")
    prefix = L.param("prefix") or ""
    if prefix:
        for o in new:
            o.name = prefix + o.name
    newset = set(new)
    top = [o for o in new if o.parent is None or o.parent not in newset]
    bpy.context.view_layer.update()
    bb0 = bbox(new)

    scale = 1.0 if sc is None else float(sc)
    measured_of = None
    if sct:
        if not bb0:
            raise RuntimeError("scale_to: the file has no meshes to measure")
        ax = "xyz".index(sct["axis"].lower())
        cur = bb0["size"][ax]
        if sct.get("of"):
            hit = [o for o in new if fnmatch.fnmatch(o.name, sct["of"])]
            if not hit:
                raise RuntimeError(f"scale_to.of: nothing matches {sct['of']!r}")
            keep, stack = set(), list(hit)
            while stack:
                o = stack.pop()
                keep.add(o)
                stack += list(o.children)
            bo = bbox(list(keep))
            if not bo:
                raise RuntimeError("scale_to.of: the matches hold no meshes")
            cur = bo["size"][ax]
            measured_of = {"matches": len(hit), "box": bo}
        if cur <= 0:
            raise RuntimeError("scale_to: the measured length is 0")
        scale = float(sct["length_m"]) / cur

    root = bpy.data.objects.new(root_name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    root["scene_append_root"] = os.path.basename(src)
    bpy.context.scene.collection.objects.link(root)
    for o in top:  # identity parent inverse: the root's matrix carries the whole transform
        o.parent = root
        o.matrix_parent_inverse = Matrix.Identity(4)
    about = Vector(L.param("about") or (0, 0, 0))
    rot = L.param("rotate_deg") or (0, 0, 0)
    Rz = Matrix.Rotation(math.radians(rot[2]), 4, "Z")
    Ry = Matrix.Rotation(math.radians(rot[1]), 4, "Y")
    Rx = Matrix.Rotation(math.radians(rot[0]), 4, "X")
    S = Matrix.Scale(scale, 4)
    T0 = Matrix.Translation(about)
    M = T0 @ (Rz @ Ry @ Rx) @ S @ T0.inverted()
    mv = L.param("move_m") or (0, 0, 0)
    M = Matrix.Translation(Vector(mv)) @ M
    root.matrix_world = M
    bpy.context.view_layer.update()
    bb1 = bbox(new)

    counts = {}
    for o in new:
        counts[o.type] = counts.get(o.type, 0) + 1
    meshes = [o for o in new if o.type == "MESH"]
    summary = {"root": root_name, "src": os.path.basename(src), "imported": counts,
               "top_level": sorted(o.name for o in top)[:60], "top_level_count": len(top),
               "bbox_before": bb0, "bbox_after": bb1, "scale_used": round(scale, 6),
               "materials": len(set(bpy.data.materials) - mats_before),
               "tris": sum(L.tris(o) for o in meshes), "measured_of": measured_of, "dry_run": dry}
    L.finish(summary, save=not dry)


L.run(main)
