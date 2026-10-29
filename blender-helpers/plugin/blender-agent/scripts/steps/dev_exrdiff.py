"""dev_exrdiff — DEV TOOL (read-only): compare two single-channel map files texel by texel. params: pairs [[a, b], ...] (absolute paths)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def load(p):
    im = bpy.data.images.load(p)
    a = np.array(im.pixels[:], np.float64).reshape(im.size[1], im.size[0], 4)[:, :, 0]
    bpy.data.images.remove(im)
    return a


def main():
    rows = []
    for a, b in L.param("pairs"):
        x, y = load(a), load(b)
        d = np.abs(x - y)
        rows.append({"a": os.path.basename(a), "b": os.path.basename(b), "texels": int(x.size), "differ": int((d > 1e-6).sum()), "max_abs_diff": float(d.max()), "sum_a": float(x.sum()), "sum_b": float(y.sum()), "lit_a": int((x > 1e-4).sum()), "lit_b": int((y > 1e-4).sum())})
    L.finish({"pairs": rows}, save=False)


L.run(main)
