"""_region - a spatial region with a smooth falloff, shared by mesh_local and uv_mask (not a verb). Positions in metres inside; the params that name a size say _mm and are millimetres, world frame (+X left, +Y back, +Z up)."""
import numpy as np

PRE = "mixamorig:"


def smooth_step(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def fade(d, inner, falloff):
    """1 where d <= inner, smoothly to 0 at inner + falloff"""
    if falloff <= 0:
        return (d <= inner).astype(float)
    return 1 - smooth_step((d - inner) / falloff)


def flipx(p, flip):
    p = np.array(p, float)
    if flip:
        p[0] = -p[0]
    return p


def region_weight(reg, V, arm, W, names, flip):
    """(weight array, centre in metres)"""
    # a selector may carry its own "mirror": true, beside the kind ({"sphere": {...}, "mirror": true}) or inside it ({"sphere": {..., "mirror": true}}): the region and its x-mirror (a union). This is for SELECTING; an edit
    # that moves things (mesh_local) must use its top-level `mirror`, which also negates the x of the edit
    if isinstance(reg, dict):
        own = reg.get("mirror") if "mirror" in reg else None
        base = {kk: vv for kk, vv in reg.items() if kk != "mirror"} if "mirror" in reg else reg
        if len(base) == 1:
            kk, vv = next(iter(base.items()))
            if isinstance(vv, dict) and "mirror" in vv and kk not in ("all", "any"):
                own = own or vv["mirror"]
                base = {kk: {a: b for a, b in vv.items() if a != "mirror"}}
        if own is not None:
            w, c = region_weight(base, V, arm, W, names, flip)
            if own:
                w = np.maximum(w, region_weight(base, V, arm, W, names, not flip)[0])
            return w, c
    if not isinstance(reg, dict) or len(reg) != 1:
        raise RuntimeError('region must be an object with exactly one of sphere, box, near_bone, group, all, any (a selector may also carry "mirror": true beside it or inside it)')
    k, v = next(iter(reg.items()))
    if k == "sphere":
        c = flipx(v["c"], flip) / 1000
        fo = float(v.get("falloff_mm", 25)) / 1000
        if "radii_mm" in v:
            r = np.array(v["radii_mm"], float) / 1000
            d = np.linalg.norm((V - c) / r, axis=1)  # 1 = the surface of the ellipsoid
            return fade(d, 1.0, fo / float(r.mean())), c
        return fade(np.linalg.norm(V - c, axis=1), float(v["r_mm"]) / 1000, fo), c
    if k == "box":
        c = flipx(v["c"], flip) / 1000
        h = np.array(v["size_mm"], float) / 2000
        out = np.maximum(np.abs(V - c) - h, 0)  # distance outside the box
        return fade(np.linalg.norm(out, axis=1), 0.0, float(v.get("falloff_mm", 20)) / 1000), c
    if k == "near_bone":
        bn = v["bone"]
        if flip:
            bn = bn.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")
        b = arm.data.bones.get(PRE + bn)
        if b is None:
            raise RuntimeError(f"no bone {bn}")
        a, e = np.array(arm.matrix_world @ b.head_local), np.array(arm.matrix_world @ b.tail_local)
        dd = e - a
        t = np.clip(((V - a) @ dd) / max(dd @ dd, 1e-12), 0, 1)
        d = np.linalg.norm(V - (a + t[:, None] * dd), axis=1)
        return fade(d, float(v["radius_mm"]) / 1000, float(v.get("falloff_mm", 25)) / 1000), (a + e) / 2
    if k == "group":
        gn = v["name"]
        if flip:
            gn = gn.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")
        if PRE + gn not in names:
            raise RuntimeError(f"no group {gn}")
        w = W[:, names.index(PRE + gn)]
        w = np.where(w >= float(v.get("min", 0.0)), w, 0.0)
        n = w > 0.01
        return w, (V[n].mean(0) if n.any() else np.zeros(3))
    if k in ("all", "any"):
        parts = [region_weight(r, V, arm, W, names, flip) for r in v]
        w = parts[0][0].copy()
        for p in parts[1:]:
            w = w * p[0] if k == "all" else np.maximum(w, p[0])
        return w, parts[0][1]
    raise RuntimeError(f"unknown region {k}")
