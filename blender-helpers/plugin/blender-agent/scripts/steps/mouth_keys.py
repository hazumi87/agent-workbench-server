"""mouth_keys — mouth shape keys on a head that mouth_cut has opened.

Keys (glTF morph targets; three.js/Unity blendshapes):
  jawOpen      lower lip, chin, lower teeth and tongue rotate about a jaw hinge
  mouthWide    lips stretch sideways
  mouthPucker  lips narrow and push forward (OO/W)
  mouthPress   lips pressed together (M/B/P)
The jaw hinge sits at nose height, at the head's depth centre. Weights are
procedural: hard across the slot, smooth where the lips join and over the cheeks.

params:
  jaw_deg     jawOpen rotation at 1.0, default 18
  rest_open   jawOpen's default value, default 0.2
  corner_share   how far the mouth corners follow the jaw, default 0.4
  smooth_iters   weight smoothing passes over the skin, default 10
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def smooth(x, a, b):
    if b == a:
        return 1.0 if x >= a else 0.0
    u = min(1.0, max(0.0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)


def main():
    mesh = L.the_mesh()
    if "mouth" not in mesh:
        raise RuntimeError("no mouth data: run mouth_cut first")
    m = json.loads(mesh["mouth"])
    line = [Vector(p) for p in m["line"]]
    width, xc, depth_c, gap = m["width"], m["center_x"], m["depth_c"], m["gap"]
    zc, yc = line[len(line) // 2].z, line[len(line) // 2].y

    def z_line(x):
        if x <= line[0].x:
            return line[0].z
        for a, b in zip(line, line[1:]):
            if x <= b.x:
                return a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x)
        return line[-1].z

    me = mesh.data
    vg = {g.name: g.index for g in mesh.vertex_groups}

    def in_group(v, name):
        return name in vg and any(g.group == vg[name] and g.weight > 0.5 for g in v.groups)

    skin = [v.co for v in me.vertices if v.co.z > zc and not in_group(v, "mouth_upper")]
    hinge = Vector((xc, sum(p.y for p in skin) / len(skin), m["nose_z"]))
    half = width / 2

    def jaw_w(v):
        if in_group(v, "mouth_lower"):
            return 1.0
        if in_group(v, "mouth_upper"):
            return 0.0
        p = v.co
        dx = abs(p.x - xc)
        outside = smooth(dx, 0.8 * half, 1.8 * half)            # 0 inside the slot span, 1 past the corners
        # below the lip line. Inside the slot span the step sits exactly AT the line:
        # the lower wall is only gap/2 below it and must move fully with the jaw (a
        # ramp reaching 1 only at `gap` would leave the lower lip edge partly fixed and stretch
        # the lip). Past the corners the step widens to a soft 18 mm blend.
        lo = -0.25 * gap * (1 - outside)
        hi = 0.25 * gap + (0.018 - 0.25 * gap) * outside
        w_z = smooth(z_line(p.x) - p.z, lo, hi)
        w_x = 1 - smooth(dx, 1.4 * half, 3.0 * half)            # cheeks follow partly
        w_b = 1 - smooth(m["chin_z"] - p.z, 0.004, 0.025)       # under the chin fades to the neck
        w_y = 1 - smooth(p.y, hinge.y - 0.01, hinge.y + 0.02)   # nothing behind the hinge
        return w_z * w_x * w_b * w_y

    def lips_w(v, rx, rz):
        if in_group(v, "mouth_lower") or in_group(v, "mouth_upper"):
            return 0.0
        p = v.co
        if p.y > yc + 0.6 * depth_c:
            return 0.0
        return math.exp(-(((p.x - xc) / (rx * width)) ** 2 + ((p.z - zc) / (rz * width)) ** 2))

    if me.shape_keys is None:
        mesh.shape_key_add(name="Basis")
    for name in ("jawOpen", "mouthWide", "mouthPucker", "mouthPress"):
        old = me.shape_keys.key_blocks.get(name)
        if old:
            mesh.shape_key_remove(old)

    theta = math.radians(float(L.param("jaw_deg", 18)))
    stats = {}

    # jaw weights: the rule above, plus the mouth CORNERS following the jaw partway
    # (a real commissure travels ~40 % of the lower lip), then smoothed over the skin
    # so the cheeks stretch evenly. Slot walls, teeth and tongue keep exact values.
    corner_share = float(L.param("corner_share", 0.4))
    corners = (line[0], line[-1])
    interior = me.materials.find("MouthInterior")
    inner, skin_v = set(), set()
    for poly in me.polygons:
        (inner if poly.material_index == interior else skin_v).update(poly.vertices)
    fixed = inner - skin_v  # slot walls only; the lip edges (skin AND wall) stay free to smooth
    w = []
    for v in me.vertices:
        if in_group(v, "mouth_lower") or in_group(v, "mouth_upper"):
            fixed.add(v.index)
        base = jaw_w(v)
        if v.index not in fixed:
            near = min((v.co - c).length for c in corners)
            base = max(base, corner_share * math.exp(-(near / (0.22 * width)) ** 2))
        w.append(base)
    nbrs = [[] for _ in me.vertices]
    for e in me.edges:
        a_, b_ = e.vertices
        nbrs[a_].append(b_)
        nbrs[b_].append(a_)
    for _ in range(int(L.param("smooth_iters", 10))):
        w = [w[i] if i in fixed or not nbrs[i] else 0.5 * w[i] + 0.5 * sum(w[j] for j in nbrs[i]) / len(nbrs[i])
             for i in range(len(w))]

    k = mesh.shape_key_add(name="jawOpen", from_mix=False)
    moved = 0
    for v in me.vertices:
        wv = w[v.index]
        if wv > 1e-4:
            r = Matrix.Rotation(theta * wv, 3, "X")
            k.data[v.index].co = hinge + r @ (v.co - hinge)
            moved += 1
    stats["jawOpen_verts"] = moved

    k = mesh.shape_key_add(name="mouthWide", from_mix=False)
    for v in me.vertices:
        g = lips_w(v, 0.75, 0.35)
        if g > 1e-4:
            d = (v.co.x - xc) / half
            k.data[v.index].co = v.co + Vector(((v.co.x - xc) * 0.22 * g, 0.002 * g * d * d, 0))

    k = mesh.shape_key_add(name="mouthPucker", from_mix=False)
    for v in me.vertices:
        g = lips_w(v, 0.7, 0.35)
        if g > 1e-4:
            fwd = max(0.0, 1 - ((v.co.x - xc) / (0.6 * width)) ** 2)
            k.data[v.index].co = v.co + Vector((-(v.co.x - xc) * 0.18 * g, -0.004 * g * fwd, -(v.co.z - zc) * 0.08 * g))

    k = mesh.shape_key_add(name="mouthPress", from_mix=False)
    for v in me.vertices:
        g = lips_w(v, 0.6, 0.18)
        if g > 1e-4:
            k.data[v.index].co = v.co + Vector((0, 0.0006 * g, -(v.co.z - z_line(v.co.x)) * 0.22 * g))

    me.shape_keys.key_blocks["jawOpen"].value = float(L.param("rest_open", 0.2))
    L.finish({"keys": [kb.name for kb in me.shape_keys.key_blocks], "hinge": [round(c, 4) for c in hinge],
              "rest_open": me.shape_keys.key_blocks["jawOpen"].value, **stats}, save=True)


L.run(main)
