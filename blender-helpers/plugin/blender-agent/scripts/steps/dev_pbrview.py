"""dev_pbrview — DEV TOOL: Cycles pictures (with materials, a three-light studio) of named objects from given directions. Read-only; pictures to out/."""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import _handview as HV  # noqa: E402


def main():
    pats = L.param("objects")
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and any(fnmatch.fnmatchcase(o.name, g) for g in pats)]
    pts = np.array([(o.matrix_world @ Vector(c))[:] for o in objs for c in o.bound_box])
    ctr = Vector(((pts.min(0) + pts.max(0)) / 2).tolist())
    ext = float(np.ptp(pts, axis=0).max())
    dirs = {v["name"]: Vector(v["dir"]) for v in L.param("views")}
    files = HV.render_views_pbr(objs, ctr, ext * 1.2, L.param("prefix", "pbr"), int(L.param("res", 720)), dirs, samples=int(L.param("samples", 24)))
    L.finish({"objects": len(objs), "pictures": [os.path.basename(f) for f in files]}, save=False, files=files)


L.run(main)
