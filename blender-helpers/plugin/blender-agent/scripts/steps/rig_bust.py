"""rig_bust — a head-and-shoulders rig built directly as the export "Skeleton"
(no Rigify: a bust has no limbs). Bones reuse the body skeleton's names so head
animation can move between busts and full bodies:

  root (non-deform, at the cut) > DEF-spine.003 (chest) > DEF-spine.004 (neck)
  > DEF-spine.006 (head)

Landmarks from the mesh (facing -Y, cut at z=0, crown at the top):
  - front profile f(z) = most-forward y of a narrow central strip
  - nose tip  = most forward point of f in the upper 60 %
  - throat    = just under the chin from face landmarks (mouth_cut's chin_z)
                when present; else the most recessed point of f between chest
                and nose (a hood collar can fool that). The head pivots there.
  - head axis = centroid y of the head above the throat
params:
  strip       half-width of the central strip, metres (default 0.03 * height / 0.36)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    mesh = L.the_mesh()
    verts = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
    H = max(v.z for v in verts)
    strip = float(L.param("strip", 0.03 * H / 0.36))
    bins = 60
    front = [None] * bins
    for v in verts:
        if abs(v.x) < strip:
            i = min(bins - 1, int(v.z / H * bins))
            front[i] = v.y if front[i] is None else min(front[i], v.y)

    def z_of(i):
        return (i + 0.5) * H / bins

    upper = [i for i in range(int(0.4 * bins), int(0.95 * bins)) if front[i] is not None]
    nose = min(upper, key=lambda i: front[i])
    z_nose = z_of(nose)
    if "mouth" in mesh:  # face landmarks (mouth_cut) beat the profile: a hood collar fools it
        z_throat = json.loads(mesh["mouth"])["chin_z"] - 0.01 * H / 0.36
        source = "landmarks"
    else:
        lower = [i for i in range(int(0.15 * bins), nose - 2) if front[i] is not None]
        z_throat = z_of(max(lower, key=lambda i: front[i]))
        source = "profile"
    head_pts = [v for v in verts if v.z > z_throat]
    y_head = sum(v.y for v in head_pts) / len(head_pts)
    z_neck_base = max(0.02 * H, z_throat - 0.35 * (H - z_throat))

    for a in L.armatures():
        bpy.data.objects.remove(a, do_unlink=True)
    arm = bpy.data.armatures.new("Skeleton")
    skel = bpy.data.objects.new("Skeleton", arm)
    bpy.context.scene.collection.objects.link(skel)
    L.activate(skel, "EDIT")
    eb = arm.edit_bones

    def bone(name, head, tail, parent=None, deform=True):
        b = eb.new(name)
        b.head, b.tail = head, tail
        b.roll = 0.0
        b.parent = parent
        b.use_deform = deform
        return b

    root = bone("root", (0, 0, 0), (0, 0.1 * H, 0), deform=False)
    chest = bone("DEF-spine.003", (0, y_head, 0), (0, y_head, z_neck_base), root)
    neck = bone("DEF-spine.004", chest.tail, (0, y_head, z_throat), chest)
    bone("DEF-spine.006", neck.tail, (0, y_head, H), neck)
    for b in (neck,):
        b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")

    L.finish({"pivot_from": source, "height": round(H, 4), "nose_z": round(z_nose, 4), "throat_z": round(z_throat, 4),
              "neck_base_z": round(z_neck_base, 4), "head_axis_y": round(y_head, 4),
              "bones": [b.name for b in arm.bones]}, save=True)


L.run(main)
