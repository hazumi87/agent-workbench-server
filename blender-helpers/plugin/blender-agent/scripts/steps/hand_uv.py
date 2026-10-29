"""hand_uv — give a hand mesh a proper UV layout: the surface is cut along the silhouette into the BACK of the hand (with the finger sides and tips) and the PALM, unwrapped (angle-based or conformal) and packed. Writes (or overwrites) the UV layer `uv_name` (default "HandUV"); other layers are untouched. Saves a checkpoint.

hand_make's own HandUV is a quick parallel projection and its edge-on walls are distorted; this verb replaces it with a real unwrap, so the paint has no flipped or collapsed faces. Run it on the standalone hand (after hand_make / hand_bones), before painting; the weights and shape are not touched.

params:
  mesh      the hand object (default "hand_L")
  uv_name   the layer to write (default "HandUV"; created when missing, made the active layer)
  palm      [x, y, z] the direction the palm faces (default [0, 0, -1]); faces whose normal points more than 3 degrees toward it are the palm, the rest (back, finger sides, tips, the wrist end) are the back
  method    "ANGLE_BASED" (default) | "CONFORMAL"
  margin    island margin in UV units (default 0.004); pack_margin (default 0.01)
  size      px for the layout picture (default 1024)
Returns: seams (edges cut), islands, stretch (50 / 95 / 99 percentile and max of the 3D-to-UV stretch ratio), flipped_triangles (UV winding against the island's majority), texel_density (mm per UV unit: mean and spread), coverage of the 0..1 square by islands, uv_bounds, pictures (out/handuv-layout.png).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import uv_common as UC  # noqa: E402


def main():
    obj = bpy.data.objects.get(L.param("mesh", "hand_L"))
    if obj is None or obj.type != "MESH":
        raise RuntimeError("no such mesh (give `mesh`)")
    me = obj.data
    palm = Vector(L.param("palm", [0, 0, -1])).normalized()
    uvn = L.param("uv_name", "HandUV")
    mw = np.array(obj.matrix_world)[:3, :3]
    pn = np.array([list(p.normal) for p in me.polygons]) @ mw.T
    is_palm = (pn @ np.array(palm)) > 0.05
    ekeys = {}
    for p in me.polygons:
        for ek in p.edge_keys:
            ekeys.setdefault(ek, []).append(p.index)
    n_seam = 0
    for e in me.edges:
        fs = ekeys.get(tuple(sorted(e.vertices)), [])
        e.use_seam = len(fs) == 2 and bool(is_palm[fs[0]]) != bool(is_palm[fs[1]])
        n_seam += int(e.use_seam)
    lay = me.uv_layers.get(uvn) or me.uv_layers.new(name=uvn)
    me.uv_layers.active = lay
    L.activate(obj, "EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method=L.param("method", "ANGLE_BASED"), fill_holes=True, margin=float(L.param("margin", 0.004)))
    bpy.ops.object.mode_set(mode="OBJECT")
    L.activate(obj, "EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(udim_source="ACTIVE_UDIM", rotate=True, margin=float(L.param("pack_margin", 0.01)))
    bpy.ops.object.mode_set(mode="OBJECT")
    # ---- measure
    tv, P, U, tl = UC.uv_arrays(me, uvn)
    P = P @ mw.T + np.array(obj.matrix_world)[:3, 3]
    a3, a2, st = UC.tri_stretch(P, U)
    lab, nis = UC.islands(me, uvn)
    # flipped: signed UV area against the island's majority sign
    e1, e2 = U[:, 1] - U[:, 0], U[:, 2] - U[:, 0]
    sa = e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]
    lt_poly = np.array([t.polygon_index for t in me.loop_triangles])
    il = lab[lt_poly]
    flipped = 0
    for k in range(nis):
        m = il == k
        if m.any():
            pos = (sa[m] > 0).sum()
            flipped += int(min(pos, m.sum() - pos))
    ok = np.isfinite(st)
    dens = np.sqrt(np.maximum(a2, 1e-18) / np.maximum(a3, 1e-18))  # UV units per metre
    d_mm = 1000.0 / np.maximum(dens, 1e-9)
    size = int(L.param("size", 1024))
    cnt = UC.raster_counts(U, size)
    os.makedirs(L.ARGS["out_dir"], exist_ok=True)
    lp = os.path.join(L.ARGS["out_dir"], "handuv-layout.png")
    UC.draw_layout(U, il, size, lp)
    L.finish({"layer": uvn, "seams": n_seam, "islands": nis, "stretch": {"p50": round(float(np.percentile(st[ok], 50)), 2), "p95": round(float(np.percentile(st[ok], 95)), 2), "p99": round(float(np.percentile(st[ok], 99)), 2), "max": round(float(st[ok].max()), 2), "non_finite_triangles": int((~ok).sum())},
              "flipped_triangles": flipped, "mm_per_uv_unit": {"median": round(float(np.median(d_mm)), 1), "p5": round(float(np.percentile(d_mm, 5)), 1), "p95": round(float(np.percentile(d_mm, 95)), 1)},
              "coverage_pct": round(float((cnt > 0).mean() * 100), 1), "overlap_pct": round(float((cnt > 1).mean() * 100), 2), "uv_bounds": [[round(float(x), 3) for x in U.reshape(-1, 2).min(0)], [round(float(x), 3) for x in U.reshape(-1, 2).max(0)]],
              "pictures": [os.path.basename(lp)]}, files=[lp], save=True)


L.run(main)
