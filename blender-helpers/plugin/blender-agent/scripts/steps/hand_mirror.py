"""hand_mirror — make the other hand from a finished one (shape, weights, UVs, painted material, stored joints), mirrored across a vertical plane: hand_L (painted, with HandUV) -> hand_R. Saves a checkpoint. The source hand is not changed.

The copy is a mirror image: vertices reflected across the plane x = plane_x_mm (the body's mid-plane, default 0), the face winding flipped so the normals point outward, the vertex groups renamed Left -> Right (mixamorig:LeftHandIndex1 -> mixamorig:RightHandIndex1), the stored `hand_joints` (the finger bone positions for hand_bones) reflected and renamed. The UV layer(s) are kept as they are (same layout, same texture: a back-of-the-hand picture maps onto the mirrored back), and the materials are SHARED with the source (the same painted material), so a repaint of one is the other. The mirror assumes the T-pose, the left hand along +X and the right along -X.

params:
  src         the finished hand (default "hand_L")
  name        the new object (default "hand_R")
  plane_x_mm  the mirror plane (default 0: the body's mid-plane)
  shift_mm    [dx, dy, dz] moved after mirroring, to land the wrist on the right cuff (a rig is often not exactly symmetric); default [0, 0, 0]
  rig_prefix  the prefix of the bone / group names (default "mixamorig:")
  armature    when given, the mirrored hand is checked against the rig's RightHand bone: the distance from the mirrored wrist to its head is reported
Returns: object, vertices, polygons, the groups renamed, hand_joints written (bones), wrist (the mirrored wrist, mm), mirrored bounds, normals check (fraction of faces whose normal points away from the hand's centre), uv layers kept, materials shared, and the distance to the RightHand bone when `armature` is given.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def swap(n):
    return n.replace("Left", "Right") if "Left" in n else n.replace("Right", "Left")


def main():
    src = bpy.data.objects.get(L.param("src", "hand_L"))
    if src is None or src.type != "MESH":
        raise RuntimeError("no source hand (give `src`)")
    pre = L.param("rig_prefix", "mixamorig:")
    name = L.param("name", "hand_R")
    if name in bpy.data.objects:
        raise RuntimeError(f"{name} exists already: the existing object is not replaced")
    px = float(L.param("plane_x_mm", 0.0)) / 1000
    sh = np.array(L.param("shift_mm", [0, 0, 0]), float) / 1000
    me = src.data.copy()
    me.name = name
    obj = bpy.data.objects.new(name, me)
    obj.matrix_world = src.matrix_world.copy()
    bpy.context.scene.collection.objects.link(obj)
    mw = np.array(obj.matrix_world)
    mi = np.linalg.inv(mw)
    bm = bmesh.new()
    bm.from_mesh(me)
    for v in bm.verts:
        pw = mw[:3, :3] @ np.array(v.co) + mw[:3, 3]
        pw[0] = 2 * px - pw[0]
        pw = pw + sh
        v.co = Vector((mi[:3, :3] @ pw + mi[:3, 3]).tolist())
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    renamed = []
    for g in obj.vertex_groups:
        n2 = swap(g.name) if (pre + "LeftHand" in g.name) else g.name
        if n2 != g.name:
            renamed.append((g.name, n2))
            g.name = n2
    bones = None
    if "hand_joints" in src:
        jj = json.loads(src["hand_joints"])
        out = {}
        for k, v in jj.items():
            k2 = swap(k)
            v2 = dict(v)
            for key in ("head_mm", "tail_mm"):
                if key in v2:
                    x, y, z = v2[key]
                    v2[key] = [round(2 * px * 1000 - x + sh[0] * 1000, 3), round(y + sh[1] * 1000, 3), round(z + sh[2] * 1000, 3)]
            if v2.get("parent"):
                v2["parent"] = swap(v2["parent"])
            out[k2] = v2
        obj["hand_joints"] = json.dumps(out)
        bones = len(out)
    # outward-normals check: the faces' normals against the direction from the centre
    P = np.array([list(v.co) for v in me.vertices])
    c = P.mean(0)
    fc = np.array([list(p.center) for p in me.polygons])
    fn = np.array([list(p.normal) for p in me.polygons])
    out_frac = float((((fc - c) * fn).sum(1) > 0).mean())
    Pw = P @ mw[:3, :3].T + mw[:3, 3]
    res = {"object": name, "vertices": len(me.vertices), "polygons": len(me.polygons), "groups_renamed": len(renamed), "hand_joints_bones": bones,
           "bounds_mm": [[round(float(x) * 1000, 1) for x in Pw.min(0)], [round(float(x) * 1000, 1) for x in Pw.max(0)]], "normals_outward_fraction": round(out_frac, 3),
           "uv_layers": [u.name for u in me.uv_layers], "materials_shared": [m.name if m else None for m in me.materials], "source_unchanged": True}
    arm = bpy.data.objects.get(L.param("armature", "")) if L.param("armature") else None
    if arm is not None and (pre + "RightHand") in arm.data.bones:
        hd = np.array(arm.matrix_world @ arm.data.bones[pre + "RightHand"].head_local)
        # the wrist: the centre of the mirrored hand's rear-most vertices
        s_end = Pw[np.argsort(np.abs(Pw[:, 0] - hd[0]))[:1]]
        res["right_hand_bone_head_mm"] = [round(float(x) * 1000, 1) for x in hd]
        res["nearest_mirrored_vertex_to_bone_head_mm"] = round(float(np.linalg.norm(Pw - hd, axis=1).min()) * 1000, 1)
    L.finish(res, save=True)


L.run(main)
