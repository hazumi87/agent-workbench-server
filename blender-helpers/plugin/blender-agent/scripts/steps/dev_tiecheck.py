"""dev_tiecheck — DEV TOOL (read-only, saves nothing): compare the baker's own coverage (lightmap_bake.raster under each tie rule) with the exact-GLB rule-B coverage of the exported file. params: glb, receivers (the direct bake's receiver globs), atlas (1024), rules (default ["top_left_b", "top_left_b_f32"]).
Reports, per rule: baker covered, GLB covered, texels covered by one and not the other, and the first examples."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402


def main():
    import lightmap_bake as LB
    import dev_tieattr_lib as T
    W = int(L.param("atlas", 1024))
    recv = LB.pick(L.param("receivers"), {"MESH"})
    cov = T.glb_cover_b(L.param("glb"), W, W)
    out = {"receivers": len(recv), "glb_covered_B": int((cov > 0).sum())}
    for rule in L.param("rules", ["top_left_b", "top_left_b_f32"]):
        LB.TIE_RULE[0] = rule
        cover, pos, nrm, owner, stats, empty = LB.raster(recv, W)
        b = np.flipud(cover > 0)
        g = cov > 0
        only_b, only_g = b & ~g, g & ~b
        out[rule] = {"baker_covered": int(b.sum()), "baker_only": int(only_b.sum()), "glb_only": int(only_g.sum()), "baker_only_first": [[int(x), int(y)] for y, x in np.argwhere(only_b)[:8]], "glb_only_first": [[int(x), int(y)] for y, x in np.argwhere(only_g)[:8]]}
    L.finish(out, save=False)


L.run(main)
