"""dev_tie — DEV TOOL: for texels (x, y in glTF rows, row 0 = v 0) of one object: which triangles of its LightmapUV contain the texel centre, and does the centre lie EXACTLY on an edge (a tie)? Read-only."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    o = bpy.data.objects[L.param("object")]
    A = int(L.param("atlas_px", 1024))
    me = o.data
    me.calc_loop_triangles()
    uv = me.uv_layers["LightmapUV"].data
    nm = o.matrix_world.to_3x3().inverted_safe().transposed()
    out = []
    for x, y in L.param("texels"):
        cx, cy = x + 0.5, y + 0.5
        row = {"texel": [x, y], "triangles": []}
        for t in me.loop_triangles:
            q = [(uv[l].uv[0] * A, (1 - uv[l].uv[1]) * A) for l in t.loops]
            a, b, c = q
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
                b, c = c, b
            e = [(b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]), (c[0] - b[0]) * (cy - b[1]) - (c[1] - b[1]) * (cx - b[0]), (a[0] - c[0]) * (cy - c[1]) - (a[1] - c[1]) * (cx - c[0])]
            if min(e) >= -1e-6:
                n = (nm @ t.normal).normalized()
                row["triangles"].append({"polygon": t.polygon_index, "edge_values": [round(v, 6) for v in e], "on_edge_exactly": any(abs(v) < 1e-6 for v in e), "normal": [round(v, 3) for v in n]})
        row["tie"] = any(tr["on_edge_exactly"] for tr in row["triangles"])
        row["n_triangles"] = len(row["triangles"])
        out.append(row)
    L.finish({"object": o.name, "texels": len(out), "ties": sum(1 for r in out if r["tie"])}, save=False, rows=out)


L.run(main)
