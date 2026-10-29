"""mesh_proportion — change a character mesh's proportions along the height: lengthen the legs, shorten the torso, keep the arms. Saves a checkpoint.

A piecewise-linear remap of height: you give anchor pairs [from_z_mm, to_z_mm] (where a landmark is now, where it should be) and every vertex's z is moved by the interpolated change, smoothed over `smooth_mm`
so there is no crease. Only the heights change; x and y are untouched, UVs and materials are kept (a stretched leg stretches its texture: rebake later). The change is weighted across the width so the arms
(which hang out beside the torso in a T-pose) are not squashed: full effect within `full_mm` of the centre line, none beyond `zero_mm`, a smooth blend between.

Do it AFTER uv_rebake, not before: a texture baked from the source onto a body that has since been reshaped misses island texels; or give `uv_rebake` the same anchors as `reshape_source`. Do it BEFORE rig_biped: a mesh that is already bound to a rig is refused (unless `allow_rigged`), because the joints would no longer match the mesh.

params:
  name       the mesh (default "body")
  anchors    [[from_mm, to_mm], ...] at least two, increasing in from_mm; z in millimetres, world; above the last anchor and below the first the change stays constant
             e.g. [[0, 0], [300, 400], [800, 900], [1000, 1000]]: crotch 300 -> 400 (legs longer), shoulders 800 -> 900, the soles and the top of the head stay
  full_mm    half-width where the change is full (default 130)
  zero_mm    half-width beyond which there is no change (default 200)
  centre_x_mm  the centre line (default the mesh's own x centre)
  smooth_mm  Gaussian smoothing of the height change (default 25)
  landmarks  optional {"crotch": 350, ...} heights in mm to report where they end up
  allow_rigged  true to remap a mesh that has a rig anyway
  dry_run    true = report only
Returns: height before/after, slope (the smallest and largest local stretch of the height: 1 = unchanged, under 1 = squeezed), landmarks before/after, moved vertices and the largest move, edge change (largest edge-length stretch and squeeze, percent),
triangles flipped (0 expected), warnings.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def main():
    o = bpy.data.objects.get(L.param("name", "body"))
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {L.param('name', 'body')}")
    if (o.vertex_groups or o.parent is not None or any(m.type == "ARMATURE" for m in o.modifiers)) and not L.param("allow_rigged", False):
        raise RuntimeError("the mesh is bound to a rig: run mesh_proportion before rig_biped, or rig_bind mode unbind first, or give allow_rigged:true (the joints will then no longer match)")
    an = L.param("anchors")
    if not (isinstance(an, list) and len(an) >= 2 and all(isinstance(a, list) and len(a) == 2 for a in an)):
        raise RuntimeError("anchors must be a list of at least two [from_mm, to_mm] pairs")
    fr = np.array([float(a[0]) for a in an]) / 1000.0
    to = np.array([float(a[1]) for a in an]) / 1000.0
    if (np.diff(fr) <= 0).any() or (np.diff(to) <= 0).any():
        raise RuntimeError("anchors must increase in both from_mm and to_mm (the order of the body along its height cannot change)")
    full, zero = float(L.param("full_mm", 130)) / 1000.0, float(L.param("zero_mm", 200)) / 1000.0
    if zero <= full:
        raise RuntimeError("zero_mm must be larger than full_mm")
    sm = float(L.param("smooth_mm", 25)) / 1000.0
    v0 = K.verts(o).copy()
    cx = float(L.param("centre_x_mm")) / 1000.0 if L.param("centre_x_mm") is not None else float((v0[:, 0].max() + v0[:, 0].min()) / 2)
    # the change of height as a function of z, on a 1 mm grid, smoothed
    z0, z1 = float(v0[:, 2].min()) - 0.1, float(v0[:, 2].max()) + 0.3
    zg = np.arange(z0, z1, 0.001)
    disp = np.interp(zg, fr, to - fr)
    disp[zg < fr[0]] = (to - fr)[0]
    disp[zg > fr[-1]] = (to - fr)[-1]
    if sm > 0:
        k = np.arange(-int(3 * sm * 1000), int(3 * sm * 1000) + 1) / 1000.0
        w = np.exp(-0.5 * (k / (sm / 2)) ** 2)
        w /= w.sum()
        pad = np.concatenate([np.full(len(k) // 2, disp[0]), disp, np.full(len(k) // 2, disp[-1])])
        disp = np.convolve(pad, w, mode="valid")[: len(zg)]
    slope = 1 + np.gradient(disp, zg)
    if slope.min() < 0.15:
        raise RuntimeError(f"the remap squeezes some height to {slope.min():.2f} of its length: move the anchors further apart or raise smooth_mm")
    wx = np.clip((np.abs(v0[:, 0] - cx) - full) / (zero - full), 0, 1)
    wx = 1 - wx * wx * (3 - 2 * wx)
    dz = np.interp(v0[:, 2], zg, disp) * wx
    v1 = v0.copy()
    v1[:, 2] = v0[:, 2] + dz
    me = o.data
    me.calc_loop_triangles()
    tri = np.array([t.vertices[:] for t in me.loop_triangles])
    edges = np.array([e.vertices[:] for e in me.edges])
    l0 = np.linalg.norm(v0[edges[:, 0]] - v0[edges[:, 1]], axis=1)
    l1 = np.linalg.norm(v1[edges[:, 0]] - v1[edges[:, 1]], axis=1)
    ratio = l1 / np.maximum(l0, 1e-9)

    def fn(v):
        a, b, c = v[tri[:, 0]], v[tri[:, 1]], v[tri[:, 2]]
        n = np.cross(b - a, c - a)
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    flipped = int(((fn(v0) * fn(v1)).sum(1) < 0).sum())
    lm = L.param("landmarks") or {}
    lm_out = {k: {"before_mm": float(z), "after_mm": round(float((float(z) / 1000.0 + np.interp(float(z) / 1000.0, zg, disp)) * 1000), 1)} for k, z in lm.items()}
    warnings = []
    if flipped:
        warnings.append(f"{flipped} triangles turned over: use a smaller change or a larger smooth_mm")
    dry = bool(L.param("dry_run", False))
    if not dry:
        K.set_verts(o, v1)
    out = {"name": o.name, "height_mm": {"before": K.mm(v0[:, 2].max() - v0[:, 2].min()), "after": K.mm(v1[:, 2].max() - v1[:, 2].min())}, "centre_x_mm": K.mm(cx),
           "slope": {"min": round(float(slope[(zg > v0[:, 2].min()) & (zg < v0[:, 2].max())].min()), 3), "max": round(float(slope[(zg > v0[:, 2].min()) & (zg < v0[:, 2].max())].max()), 3)},
           "landmarks": lm_out, "moved_vertices": int((np.abs(dz) > 1e-6).sum()), "max_move_mm": K.mm(np.abs(dz).max()),
           "edge_change_pct": {"largest_stretch": round(float((ratio.max() - 1) * 100), 1), "largest_squeeze": round(float((1 - ratio.min()) * 100), 1)},
           "triangles_flipped": flipped, "warnings": warnings, "dry_run": dry}
    L.finish(out, save=not dry)


L.run(main)
