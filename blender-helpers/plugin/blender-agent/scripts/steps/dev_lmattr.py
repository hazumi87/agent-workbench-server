"""dev_lmattr — DEV TOOL (read-only, saves nothing, bakes nothing): exhaustive counts and residual attribution of a lightmap set against the checkpoint it was baked from.
params: bin, mask (absolute paths of the packed .bin and .mask.u8; row 0 = glTF v 0), width, height (default 256), receivers [object names, in the baker's sorted order], fixtures [{"light": "bulb_A-01.light", "channel": 0}], hide_cast (globs ignored by the visibility rays; default ["bulb_*.diffuser"]), dmin_m (0.1)
Per receiver x channel (finite counts over every texel of mask label 1 and label 2): zero / nonzero / min / max / sum. For the covered texels: the stored value against cos/d^2 from the light, once with the GEOMETRIC face normal (what the baker's probes use) and once with the INTERPOLATED vertex normal (what Cycles shades a smooth face with); a ray to the light says unblocked (diffusers ignored); percentiles of stored/expected overall and by cos band; self (own light) and neighbour separately."""
import fnmatch
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.interpolate import poly_3d_calc  # noqa: E402


def pct(a, qs=(1, 10, 50, 90, 99)):
    return [round(float(np.percentile(a, q)), 4) for q in qs] if len(a) else None


def main():
    W, H = int(L.param("width", 256)), int(L.param("height", 256))
    names = L.param("receivers")
    fixtures = L.param("fixtures")
    hide = L.param("hide_cast", ["bulb_*.diffuser"])
    dmin = float(L.param("dmin_m", 0.1))
    objs = [bpy.data.objects[n] for n in names]
    import lightmap_bake as LB
    cover, pos, nrm, owner, stats, empty = LB.raster(objs, W)
    binf = np.fromfile(L.param("bin"), np.float16).astype(np.float64).reshape(H, W, 4)  # row 0 = top
    mask = np.fromfile(L.param("mask"), np.uint8).reshape(H, W)
    cov = np.flipud(cover > 0)
    own = np.flipud(owner)
    P = np.flipud(pos)
    N = np.flipud(nrm)
    dg = bpy.context.evaluated_depsgraph_get()
    out = {"conventions": {"bin": "float16 RGBA, row 0 = glTF v 0 (top), channel c = fixture c of layer 0", "mask": "0 not receiver, 1 receiver, 2 padding", "owner": "baker raster (LightmapUV, inclusive tie rule) flipped to glTF rows; receiver index = the order of `receivers`"},
           "mask_vs_raster": {"label1": int((mask == 1).sum()), "label2": int((mask == 2).sum()), "raster_covered": int(cov.sum()), "covered_not_label1": int((cov & (mask != 1)).sum()), "label1_not_covered": int(((mask == 1) & ~cov).sum())}}
    counts = []
    for ri, ro in enumerate(objs):
        for fx in fixtures:
            ch = binf[:, :, int(fx["channel"])]
            row = {"receiver": ro.name, "fixture": fx["light"], "channel": int(fx["channel"]), "kind": "self" if fx["light"].replace(".light", ".diffuser") == ro.name else "neighbour"}
            for lab, lname in ((1, "covered_label1"), (2, "padding_label2")):
                m = (mask == lab) & (own == ri) if lab == 1 else (mask == lab) & (np.flipud(owner) >= -1)
                if lab == 2:
                    m = mask == 2  # padding has no single owner in the mask: counted over the whole atlas for this channel
                v = ch[m]
                row[lname] = {"texels": int(m.sum()), "zero": int((v == 0).sum()), "nonzero": int((v > 0).sum()), "min": float(v.min()) if len(v) else None, "max": float(v.max()) if len(v) else None, "sum": float(v.sum())}
            out_ = (mask == 0)
            row["label0_nonzero_texels_in_atlas"] = int((ch[out_] > 0).sum())
            counts.append(row)
    out["counts"] = counts
    # per-texel attribution
    ys, xs = np.nonzero(cov)
    lights = {fx["light"]: np.array(bpy.data.objects[fx["light"]].matrix_world.translation) for fx in fixtures}
    smooth_n = np.zeros((len(ys), 3))
    for k, (y, x) in enumerate(zip(ys, xs)):
        o = objs[int(own[y, x])]
        mw = o.matrix_world
        lp = mw.inverted() @ Vector(P[y, x])
        ok, loc, fnrm, fi = o.closest_point_on_mesh(lp)
        poly = o.data.polygons[fi]
        vs = [o.data.vertices[i] for i in poly.vertices]
        wts = poly_3d_calc([v.co for v in vs], loc)
        nn = sum((v.normal * w for v, w in zip(vs, wts)), Vector()) if poly.use_smooth else Vector(poly.normal)
        nn = (mw.to_3x3().inverted().transposed() @ nn).normalized()
        smooth_n[k] = (nn.x, nn.y, nn.z)
    posk = P[ys, xs]
    ownk = own[ys, xs].astype(int)
    nface = N[ys, xs]
    # interior: three texels from the island edge, same surface (baker's rule, simplified to cover only)
    interior = cov.copy()
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            interior &= np.roll(np.roll(cov, dy, 0), dx, 1)
    ik = interior[ys, xs]
    res = []
    depsc = dg
    for fx in fixtures:
        lp = lights[fx["light"]]
        stored = binf[ys, xs, int(fx["channel"])]
        dv = lp[None, :] - posk
        d = np.linalg.norm(dv, axis=1)
        u = dv / np.maximum(d, 1e-9)[:, None]
        cf = (u * nface).sum(axis=1)
        cs = (u * smooth_n).sum(axis=1)
        dd = np.maximum(d, dmin)
        ef = np.maximum(0.0, cf) / dd ** 2
        es = np.maximum(0.0, cs) / dd ** 2
        blocked = np.zeros(len(ys), bool)
        for k in range(len(ys)):
            if max(cf[k], cs[k]) <= 0:
                continue
            o = Vector(posk[k]) + Vector(smooth_n[k]) * 1e-4
            dirv = Vector(lp) - o
            dist = dirv.length
            dirv.normalize()
            cur = o
            left = dist - 1e-4
            for _ in range(6):
                hit, loc, nrm_, idx, ob, mtx = bpy.context.scene.ray_cast(dg, cur, dirv, distance=left)
                if not hit:
                    break
                if any(fnmatch.fnmatchcase(ob.name, g) for g in hide):
                    step = (loc - cur).length + 1e-4
                    cur = cur + dirv * step
                    left -= step
                    if left <= 0:
                        break
                    continue
                blocked[k] = True
                break
        selfk = np.array([objs[i].name == fx["light"].replace(".light", ".diffuser") for i in ownk])
        for kind, sel in (("self", selfk), ("neighbour", ~selfk)):
            base = sel & ik & ~blocked
            r = {"fixture": fx["light"], "kind": kind, "texels_covered": int(sel.sum()), "interior": int((sel & ik).sum()), "blocked_by_non_diffuser": int((sel & blocked).sum()),
                 "stored_nonzero": int((stored[sel] > 0).sum()), "stored_zero": int((stored[sel] == 0).sum()),
                 "face_cos_positive": int((sel & (cf > 0)).sum()), "smooth_cos_positive": int((sel & (cs > 0)).sum()), "face_pos_smooth_nonpos": int((sel & (cf > 0) & (cs <= 0)).sum()), "face_nonpos_smooth_pos": int((sel & (cf <= 0) & (cs > 0)).sum()),
                 "stored_nonzero_where_both_cos_nonpos": int((sel & (cf <= 0) & (cs <= 0) & (stored > 0)).sum()), "stored_zero_where_face_cos_gt_0.05": int((sel & (cf > 0.05) & (stored == 0)).sum()),
                 "max_stored_where_smooth_cos_nonpos": float(stored[sel & (cs <= 0)].max()) if (sel & (cs <= 0)).any() else None}
            for tag, e, c in (("face_normal", ef, cf), ("smooth_normal", es, cs)):
                use = base & (e > 1e-4) & (c > 0.05)
                ratio = stored[use] / e[use]
                bands = {}
                for lo, hi in ((0.05, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)):
                    b = use & (c >= lo) & (c < hi)
                    bands[f"{lo}-{hi}"] = {"n": int(b.sum()), "p10_p50_p90": pct(stored[b] / e[b], (10, 50, 90))}
                r[tag] = {"n": int(use.sum()), "p1_p10_p50_p90_p99": pct(ratio), "within_5pct": int((np.abs(ratio - 1) <= 0.05).sum()), "within_10pct": int((np.abs(ratio - 1) <= 0.10).sum()), "within_20pct": int((np.abs(ratio - 1) <= 0.20).sum()), "by_cos_band": bands}
            res.append(r)
    out["attribution"] = res
    L.finish(out, save=False)


L.run(main)
