"""reference_pose — choose which reference poses show, or build the reference at ANY captured instant. Saves a checkpoint.

Works on the reference collection made by reference_import. `show` picks the poses that are visible (the rest are hidden); `time_s` builds a new baked body mesh and a position-derived armature for that instant
from capture-motion.npz (the nearest of the captured presentation instants) in the same coordinates as the imported poses.

params:
  show        list of pose names to make visible: an imported pose label ("000500ms") or one built here ("t012345ms"); [] = hide all (default: leave visibility as it is)
  parts       "both" (default), "mesh" or "joints": what is visible of a shown pose
  time_s      build the reference at this time (seconds, 0 to the clip length) and show it
  kind        "smooth" (default) or "observed". observed refuses an instant where the capture was not observed (inferred or bridged)
  bundle      the bundle folder or zip (see reference_import) (needed for time_s)
Returns: poses (name, visible parts, time_s, inferred), built (for time_s: name, frame index, instant, inferred, observed_valid, mesh height and lowest point, objects), notes.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _bundle as B  # noqa: E402

COLLECTION = "VideoTo3D_MetaReference"
PREFERRED = {0: 1, 1: 34, 2: 3, 3: 4, 4: 8, 18: 19, 19: 20, 20: 24, 34: 35, 35: 36, 36: 37, 37: 110, 38: 39, 39: 40, 40: 42, 74: 75, 75: 76, 76: 78, 110: 113, 113: 126}  # the bundle helper's drawing convention


def build(parent_col, label, joints, verts, faces, names, parents, t, inferred):
    sub = bpy.data.collections.new("Meta_" + label)
    parent_col.children.link(sub)
    mesh = bpy.data.meshes.new("MetaMesh_" + label)
    mesh.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(map(int, f)) for f in faces])
    mesh.update()
    body = bpy.data.objects.new("MetaBody_" + label, mesh)
    sub.objects.link(body)
    mat = bpy.data.materials.get("Meta reference cyan")
    if mat is None:
        mat = bpy.data.materials.new("Meta reference cyan")
        mat.diffuse_color = (.035, .42, .62, 1)
    body.data.materials.append(mat)
    armature = bpy.data.armatures.new("MetaSkeleton_" + label)
    arm = bpy.data.objects.new("MetaJoints_" + label, armature)
    sub.objects.link(arm)
    arm.show_in_front = True
    armature.display_type = "STICK"
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    pts = [Vector(map(float, p)) for p in joints]
    bones = []
    for i, nm in enumerate(names):
        b = armature.edit_bones.new(f"{i:03d}_{nm}")
        b.head = pts[i]
        kids = [k for k, p in enumerate(parents) if p == i]
        c = PREFERRED.get(i, kids[0] if kids else None)
        tail = pts[c] if c is not None else pts[i] + Vector((0, 0, .01))
        if (tail - pts[i]).length < 1e-5:
            tail = pts[i] + Vector((0, 0, .01))
        b.tail = tail
        if parents[i] >= 0:
            b.parent = bones[parents[i]]
        b.use_connect = False
        b.use_deform = False
        bones.append(b)
    bpy.ops.object.mode_set(mode="OBJECT")
    for ob in (body, arm):
        ob["capture_time_s"] = float(t)
        ob["inferred"] = bool(inferred)
        ob["reference_only"] = True
        ob["note"] = "Baked captured geometry / position-derived skeleton; no original MHR skin or twist."
    return sub, body, arm


def main():
    root = bpy.data.collections.get(COLLECTION)
    if root is None:
        raise RuntimeError("no reference in this scene: run reference_import first")
    built = None
    if L.param("time_s") is not None:
        b = L.param("bundle")
        if not b:
            raise RuntimeError("bundle is required with time_s")
        d = B.bundle(b)
        z = np.load(d / "capture-motion.npz", allow_pickle=False)
        t = float(L.param("time_s"))
        times = z["times_s"]
        if t < float(times[0]) - 1e-6 or t > float(times[-1]) + 1e-6:
            raise RuntimeError(f"time_s must be within {float(times[0]):g} to {float(times[-1]):g}")
        k = int(np.argmin(np.abs(times - t)))
        kind = L.param("kind", "smooth")
        if kind not in ("smooth", "observed"):
            raise RuntimeError('kind must be "smooth" or "observed"')
        inferred, valid = bool(z["inferred"][k]), bool(z["observed_valid"][k])
        if kind == "observed" and not valid:
            raise RuntimeError(f"no observed capture at {float(times[k]):.3f} s (inferred={inferred}): use kind smooth, or another time")
        j, v = z[f"joints_{kind}"][k], z[f"vertices_{kind}"][k]
        label = f"t{int(round(float(times[k]) * 1000)):06d}ms" + ("" if kind == "smooth" else "_obs")
        old = bpy.data.collections.get("Meta_" + label)
        if old is not None:
            for ob in list(old.objects):
                bpy.data.objects.remove(ob)
            bpy.data.collections.remove(old)
        sub, body, arm = build(root, label, j, v, z["faces"], [str(x) for x in z["joint_names"]], [int(x) for x in z["parents"]], float(times[k]), inferred)
        built = {"name": label, "frame": k, "instant_s": round(float(times[k]), 4), "kind": kind, "inferred": inferred, "observed_valid": valid, "mesh": body.name, "armature": arm.name,
                 "mesh_height_m": round(float(v[:, 2].max() - v[:, 2].min()), 3), "mesh_lowest_m": round(float(v[:, 2].min()), 3)}
    show = L.param("show")
    if built and show is None:
        show = [built["name"]]
    parts = L.param("parts", "both")
    if parts not in ("both", "mesh", "joints"):
        raise RuntimeError('parts must be "both", "mesh" or "joints"')
    subs = {c.name[5:].split("_INFERRED")[0]: c for c in root.children if c.name.startswith("Meta_")}
    if show is not None:
        bad = [s for s in show if s not in subs]
        if bad:
            raise RuntimeError(f"no such pose: {', '.join(bad)}; the poses are {', '.join(sorted(subs))}")
        for nm, c in subs.items():
            vis = nm in show
            c.hide_viewport = c.hide_render = not vis
            for ob in c.objects:
                ob.hide_viewport = ob.hide_render = not (vis and (parts == "both" or (parts == "mesh") == (ob.type == "MESH")))
    out = {"poses": [{"name": nm, "visible": not c.hide_viewport, "objects": [{"name": o.name, "type": o.type, "visible": not o.hide_viewport} for o in c.objects]} for nm, c in sorted(subs.items())],
           "built": built}
    L.finish(out, save=True)


L.run(main)
