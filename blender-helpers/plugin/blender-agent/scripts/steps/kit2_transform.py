"""kit2_transform — move, rotate and/or scale any ONE part by name. Saves a checkpoint.

Order of the three: scale, then rotate, then move. Scale and rotate act about `about`.
Reports the part's width : height : depth (x : z : y) before and after, so a rigid part that lost its proportions shows up:
when they change by more than 5% the result carries a `warnings` entry with the percentages.

params:
  name         object name (required)
  scale        number = uniform scale (proportions kept), or [sx, sy, sz] = per axis (proportions change)
  rotate_deg   [rx, ry, rz] degrees about the world X, Y, Z axes through `about` (applied X, then Y, then Z)
  move_mm      [dx, dy, dz] millimetres in the world frame (+X = the character's left, +Y = backwards, +Z = up)
  about        "centre" (the part's own bounding-box centre, default) or [x, y, z] metres
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Euler  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def main():
    name = L.param("name")
    if name not in bpy.data.objects:
        raise RuntimeError(f"no object named {name}")
    o = bpy.data.objects[name]
    L.activate(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    v = K.verts(o)
    before = K.proportions(v)
    centre = [float(x) for x in (v.max(0) + v.min(0)) / 2]
    about = L.param("about", "centre")
    pivot = np.array(centre if about == "centre" else about, dtype=float)
    sc = L.param("scale")
    if sc is not None:
        s = np.array([sc] * 3 if isinstance(sc, (int, float)) else sc, dtype=float)
        if s.shape != (3,) or (s <= 0).any():
            raise RuntimeError("scale must be a positive number or three positive numbers")
        v = pivot + (v - pivot) * s
    rot = L.param("rotate_deg")
    if rot is not None:
        m = np.array(Euler([math.radians(a) for a in rot], "XYZ").to_matrix())
        v = pivot + (v - pivot) @ m.T
    mv = L.param("move_mm")
    if mv is not None:
        v = v + np.array(mv, dtype=float) / 1000
    K.set_verts(o, v)
    after = K.proportions(v)
    warn = K.proportion_warning(name, before, after)
    L.finish({"warnings": [warn] if warn else [], "name": name, "scale": sc, "rotate_deg": rot, "move_mm": mv, "about_m": [round(x, 4) for x in pivot],
              "centre_before_mm": [K.mm(x) for x in centre], "centre_after_mm": [K.mm(x) for x in (v.max(0) + v.min(0)) / 2],
              "proportions_before": before, "proportions_after": after,
              "proportion_change_pct": K.proportion_change_pct(before, after),
              "checks": K.mesh_checks(o)}, save=True)


L.run(main)