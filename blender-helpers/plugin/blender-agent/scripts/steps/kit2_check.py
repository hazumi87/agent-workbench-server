"""kit2_check — part-to-BODY numbers for every part in the scene (body object named by `body`, default "body.001" or "body").

Per part: non-manifold edges, loose islands, triangles; signed distance of the part's surface to the body
(median, deepest sink p5, furthest float p95, mm; negative = inside the body); size.
For show-through (body visible where a part should cover it) use kit2_showthrough.
params:
  body    object name of the body
  parts   list of object names (default every other mesh except `ref`)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def main():
    bname = L.param("body", "body.001" if "body.001" in bpy.data.objects else "body")
    body = bpy.data.objects[bname]
    bb = K.bvh_of(body)
    bv = K.verts(body)
    names = L.param("parts") or [o.name for o in L.meshes() if o.name not in (bname, "ref")]
    out = {}
    for n in names:
        o = bpy.data.objects[n]
        v = K.verts(o)
        sd = K.surf_signed(bb, K.sample(v, 2500, 7))
        e = K.mesh_checks(o)
        e["to_body_mm"] = {"median": K.mm(np.median(sd)), "sink_p5": K.mm(np.percentile(sd, 5)), "float_p95": K.mm(np.percentile(sd, 95))}
        e["size_mm"] = [round(x * 1000) for x in K.size_of(v)]
        out[n] = e
    # whole-character numbers
    allv = np.concatenate([K.verts(bpy.data.objects[n]) for n in names] + [bv])
    out["_character"] = {"tris": sum(L.tris(bpy.data.objects[n]) for n in names) + L.tris(body),
                         "size_mm": [round(x * 1000) for x in K.size_of(allv)]}
    L.finish(out, save=False)


L.run(main)