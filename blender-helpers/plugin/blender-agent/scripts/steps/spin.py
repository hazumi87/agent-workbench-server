"""spin — the acceptance look at one part: the part from front, 45 degrees, edge-on, back and the opposite 45 degrees, as ONE contact sheet (clay or PBR). Reads only; saves no checkpoint.

Angles are turns about the vertical (Z) axis from the front view (the camera on the -Y side, looking toward +Y): 0 = front, +45 = turned toward the character's left (+X), 90 = edge-on from the left, 180 = back, -45 = turned toward the right. A slight look-down (`pitch_deg`) shows the top.

params:
  part       the object name (required); `with`: other objects shown with it (default none: the part alone); `parts`: several objects as one subject
  angles_deg list of turns (default [0, 45, 90, 180, -45]); n: use the first n of them (default all)
  shading    "clay" (default, Workbench) or "pbr" (the part's own materials, Cycles on the CPU, `samples` default 16)
  pitch_deg  look-down angle (default 12)
  res        px of each tile (default 480); size_m the picture width in metres (default 1.5 x the subject's largest extent)
  columns    tiles per row (default: all in one row)
Returns: sheet (out/spin-<part>.png), tiles (angle, file), the subject's bounds (m) and size, the order left to right then top to bottom.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402
from _handview import render_views, render_views_pbr  # noqa: E402


def main():
    names = L.param("parts") or [L.param("part")]
    if not names or names[0] is None:
        raise RuntimeError("give `part` (an object name)")
    objs = [bpy.data.objects.get(n) for n in names]
    if any(o is None for o in objs):
        raise RuntimeError(f"no such object in {names}")
    shown = objs + [bpy.data.objects[n] for n in (L.param("with") or []) if n in bpy.data.objects]
    pts = np.array([(o.matrix_world @ Vector(c))[:] for o in objs for c in o.bound_box])
    ctr = Vector(((pts.min(0) + pts.max(0)) / 2).tolist())
    ext = float(np.ptp(pts, axis=0).max())
    size = float(L.param("size_m", ext * 1.5))
    angles = list(L.param("angles_deg", [0, 45, 90, 180, -45]))
    if L.param("n"):
        angles = angles[: int(L.param("n"))]
    pitch = math.radians(float(L.param("pitch_deg", 12)))
    res = int(L.param("res", 480))
    dirs = {}
    for a in angles:
        t = math.radians(float(a))
        # the front camera sits on the -Y side; a positive turn moves it toward +X (the character's left)
        d = Vector((math.sin(t) * math.cos(pitch), -math.cos(t) * math.cos(pitch), math.sin(pitch)))
        dirs[f"a{int(a):+d}"] = d
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    if L.param("shading", "clay") == "pbr":
        files = render_views_pbr(shown, ctr, size, "spin-tile", res, dirs, samples=int(L.param("samples", 16)))
    else:
        files = render_views(shown, ctr, size, "spin-tile", res, dirs)
    tiles = [UC.load_image(f)[..., :3] for f in files]
    cols = int(L.param("columns", len(tiles)))
    rows = int(math.ceil(len(tiles) / cols))
    sheet = np.full((rows * res, cols * res, 3), 0.1, np.float32)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * res:(r + 1) * res, c * res:(c + 1) * res] = t
        # a small tick strip on top of each tile: its angle as that many 4-px marks (0 = none; sign by colour: left = amber, right = cyan, 180 = white)
        a = angles[i]
        col = (1, 1, 1) if abs(a) >= 135 else ((1.0, 0.7, 0.1) if a > 0 else ((0.2, 0.9, 1.0) if a < 0 else (0.6, 0.6, 0.6)))
        n = int(round(abs(a) / 15))
        for k in range(n):
            sheet[r * res + 4:r * res + 12, c * res + 6 + k * 8:c * res + 11 + k * 8] = col
    sp = os.path.join(L.ARGS["out_dir"], f"spin-{names[0]}.png")
    UC.save_image(sheet, sp, "sRGB")
    L.finish({"sheet": os.path.basename(sp), "tiles": [{"angle_deg": a, "file": os.path.basename(f)} for a, f in zip(angles, files)], "order": "left to right, then top to bottom: " + ", ".join(str(a) for a in angles),
              "subject_bounds_m": [[round(float(x), 4) for x in pts.min(0)], [round(float(x), 4) for x in pts.max(0)]], "size_m": round(size, 3), "pitch_deg": math.degrees(pitch),
              "legend": "the marks on each tile's top edge: one mark per 15 degrees of turn (amber toward the character's left, cyan toward the right, white = back)"}, files=[sp] + files)


L.run(main)
