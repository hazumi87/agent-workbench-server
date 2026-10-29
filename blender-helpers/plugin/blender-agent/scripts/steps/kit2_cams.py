"""kit2_cams — default cameras that are placed from the character's own measurements (the feet), not fixed numbers.

derived(ref) measures the reference (height, the two feet: centre, length, width, stance) and returns, by camera id, a pose:
  feet-top         both feet together from in front and above (50 degrees down), wide enough for the stance: the tops of the feet, toes
                   and ankles fill the frame (where straps cross the instep)
  foot-left-side / foot-right-side   each foot from its outer side
  foot-left-34 / foot-right-34       each foot from the outer front, a little above
and `foot` (level, from the front) keeps its fixed pose. Each entry: position, target (metres, Z up), fov (vertical degrees), direction
(from the target toward the camera, unit), size (width of the picture at the target, metres: the orthographic size).
Arm cameras: arm-left-end and arm-right-end look back along each arm from beyond the fingertips (placed from the fingertip, the narrowest cross-section = wrist, and the elbow at the template proportion).
The character is assumed to stand on z = its lowest point, face -Y, with its left on +X. Returns {} when the feet cannot be found.
"""
import math

import numpy as np

import bpy


def _world_verts(o):
    n = len(o.data.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    o.data.vertices.foreach_get("co", co)
    m = np.array(o.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def measure(ref):
    v = _world_verts(ref)
    zmin, zmax = float(v[:, 2].min()), float(v[:, 2].max())
    h = zmax - zmin
    band = v[v[:, 2] < zmin + 0.12 * h]
    feet = {}
    for name, sgn in (("left", 1), ("right", -1)):
        p = band[band[:, 0] * sgn > 0.01 * h]
        if len(p) < 50:
            return None
        lo, hi = np.percentile(p, 2, axis=0), np.percentile(p, 98, axis=0)
        feet[name] = {"centre": [float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2)], "length": float(hi[1] - lo[1]), "width": float(hi[0] - lo[0])}
    return {"height": h, "zmin": zmin, "feet": feet, "band_h": 0.12 * h}


def _cam(target, direction, half_extent, fov):
    d = np.array(direction, dtype=float)
    d /= np.linalg.norm(d)
    dist = half_extent / math.tan(math.radians(fov) / 2)
    pos = np.array(target) + d * dist
    return {"position": [round(float(x), 4) for x in pos], "target": [round(float(x), 4) for x in target], "fov": float(fov),
            "direction": [round(float(x), 4) for x in d], "size": round(float(2 * half_extent), 4)}


def measure_arms(ref):
    """per side: fingertip, wrist (the narrowest cross-section of the outer arm), elbow (template proportion), and the axis centre at each."""
    v = _world_verts(ref)
    zmin, zmax = float(v[:, 2].min()), float(v[:, 2].max())
    h = zmax - zmin
    xmax = float(np.abs(v[:, 0]).max())
    arms = {}
    for name, sg in (("left", 1), ("right", -1)):
        s = v[v[:, 0] * sg > 0.4 * xmax]
        if len(s) < 200:
            continue
        tip_x = float((s[:, 0] * sg).max())
        best, wx = None, None
        for xs in np.linspace(0.62 * tip_x, 0.95 * tip_x, 24):
            sl = s[np.abs(s[:, 0] * sg - xs) < 0.012 * h]
            if len(sl) < 30:
                continue
            area = float((np.percentile(sl[:, 2], 95) - np.percentile(sl[:, 2], 5)) * (np.percentile(sl[:, 1], 95) - np.percentile(sl[:, 1], 5)))
            if best is None or area < best:
                best, wx = area, xs
        if wx is None:
            continue
        sh_x = 0.2 * tip_x
        el_x = sh_x + 0.52 * (wx - sh_x)

        def centre(xv):
            sl = s[np.abs(s[:, 0] * sg - xv) < 0.015 * h]
            sl = sl if len(sl) > 20 else s
            return np.array([sg * xv, (np.percentile(sl[:, 1], 5) + np.percentile(sl[:, 1], 95)) / 2, (np.percentile(sl[:, 2], 5) + np.percentile(sl[:, 2], 95)) / 2])
        tip = s[np.argmax(s[:, 0] * sg)]
        arms[name] = {"sg": sg, "tip": np.array([sg * tip_x, centre(0.9 * tip_x)[1], centre(0.9 * tip_x)[2]]), "wrist": centre(wx), "elbow": centre(el_x), "hand_len": float(tip_x - wx)}
    return arms


def derived(ref):
    out = {}
    try:
        out.update(_arm_cams(ref))
    except Exception:  # noqa: BLE001 - one measurement failing must not take the others with it
        pass
    out.update(_foot_cams(ref))
    return out


def _arm_cams(ref):
    """arm-left-end / arm-right-end: out beyond the fingertips, looking back along the arm to the elbow and the shoulder, a little in front of
    and above the arm's axis, so the hand is nearest, then the wrist and forearm, with the whole ring of a cuff visible around the arm."""
    out = {}
    for name, a in measure_arms(ref).items():
        u = a["tip"] - a["elbow"]
        L = float(np.linalg.norm(u))
        u = u / L
        pos = a["tip"] + u * (1.1 * L) + np.array([0, -0.25 * L, 0.25 * L])
        out[f"arm-{name}-end"] = _cam_from(pos, a["elbow"], 32)
    return out


def _cam_from(pos, target, fov):
    d = np.array(pos) - np.array(target)
    dist = float(np.linalg.norm(d))
    return {"position": [round(float(x), 4) for x in pos], "target": [round(float(x), 4) for x in target], "fov": float(fov),
            "direction": [round(float(x), 4) for x in d / dist], "size": round(2 * dist * math.tan(math.radians(fov) / 2), 4)}


def _foot_cams(ref):
    m = measure(ref)
    if not m:
        return {}
    zt = m["zmin"] + 0.45 * m["band_h"]  # about the instep
    fl, fr = m["feet"]["left"], m["feet"]["right"]
    out = {}
    cx, cy = (fl["centre"][0] + fr["centre"][0]) / 2, (fl["centre"][1] + fr["centre"][1]) / 2
    stance = abs(fl["centre"][0] - fr["centre"][0])
    half = max(stance / 2 + max(fl["width"], fr["width"]) / 2, max(fl["length"], fr["length"]) / 2) * 1.3
    el = math.radians(50)
    out["feet-top"] = _cam([cx, cy, zt], [0, -math.cos(el), math.sin(el)], half, 34)
    for name, sgn, f in (("left", 1, fl), ("right", -1, fr)):
        t = [f["centre"][0], f["centre"][1], zt + 0.1 * m["band_h"]]
        out[f"foot-{name}-side"] = _cam(t, [sgn, 0, 0.05], f["length"] * 0.7, 24)
        out[f"foot-{name}-34"] = _cam(t, [sgn * 0.7, -0.7, 0.25], f["length"] * 0.7, 24)
    return out


def apply_to_cams(cams, der):
    """override the pose of each camera dict in `cams` (id, position, target, fov) that has a derived pose."""
    for c in cams:
        d = der.get(c["id"])
        if d:
            c["position"], c["target"], c["fov"] = d["position"], d["target"], d["fov"]
    return cams