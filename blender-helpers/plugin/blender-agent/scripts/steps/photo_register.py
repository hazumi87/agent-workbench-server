"""photo_register — solve the camera correction of a photo from landmarks you pick: pairs of a point on the posed copy and the same point in the photo. Reads only; saves no checkpoint.

photo_project's camera is the captured video's: a hint. When the face (or anything) lands in the wrong place, give a few corresponding points (eye corners, nose tip, mouth corners, chin) and this verb solves the small correction that
puts them where the photo has them: a shift of the principal point, and optionally a focal scale. It prints the values to paste into photo_project (`shift`, `shift_space`: "image", `focal_scale`) and how well each point fits before and after.
You read the photo's pixel positions off the picture yourself (a viewer or the reproject-<n>.png), and name each model point in one of three ways.

params:
  bundle   the bundle folder or zip (see reference_import) (camera-reference.json)
  time_s   the captured instant (default 0.5)
  image    the photo (same forms as photo_project: relative to the bundle, absolute, "out:<file>", a Library id): only its size is used; px coordinates are in ITS pixels, origin top-left, u right, v down
  mesh     the posed copy (default "body_posed")
  uv       the UV layer used when a point is given by `uv` (default the active one)
  points   list of {"name": "eye_L", "px": [u, v], and ONE of
             "mm": [x, y, z]   a point in the posed copy's frame, millimetres (the reference frame, floor z = 0, +X left, +Y back, +Z up)
             "uv": [u, v]      a point on the UV sheet (0..1, v up): the surface point there on the posed copy
             "vertex": n       a vertex of the posed copy}
           at least 2 points (3 or more is better: they check each other); "weight" optional per point
  start    {"shift": [dx, dy], "shift_space": "image", "focal_scale": 1.0}: the camera you were using, so the residuals before are those of that camera (default none)
  solve    "both" (default: shift and focal scale) | "shift" (shift only; focal scale stays at start's)
Returns: image_size, camera used, points (name, model 3D mm, photo px, projected px before, residual before px, projected after, residual after px), before / after rms px, solved: shift (image px), focal_scale, and `recommend`: the photo_project photo settings.
`shift_only` is always given as well (what the points say if the focal length is left alone). notes warn when the focal scale moves far from 1 or the points are nearly collinear.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import _bundle as B  # noqa: E402
import uv_common as UC  # noqa: E402
from _photocam import camera_for  # noqa: E402


def uv_to_point(U, P3, uv):
    """the 3D point on the copy at sheet position uv: U (T,3,2) UV triangles, P3 (T,3,3) their 3D corners"""
    a, b, c = U[:, 0], U[:, 1], U[:, 2]
    d = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    ok = np.abs(d) > 1e-14
    d = np.where(ok, d, 1)
    l1 = ((b[:, 1] - c[:, 1]) * (uv[0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (uv[1] - c[:, 1])) / d
    l2 = ((c[:, 1] - a[:, 1]) * (uv[0] - c[:, 0]) + (a[:, 0] - c[:, 0]) * (uv[1] - c[:, 1])) / d
    inside = ok & (l1 >= -1e-6) & (l2 >= -1e-6) & (1 - l1 - l2 >= -1e-6)
    if not inside.any():
        raise RuntimeError(f"no surface at UV {list(uv)}: it lies outside every island")
    t = int(np.argmax(inside))
    return P3[t, 0] * l1[t] + P3[t, 1] * l2[t] + P3[t, 2] * (1 - l1[t] - l2[t])


def main():
    b = L.param("bundle")
    if not b:
        raise RuntimeError("bundle is required")
    d = B.bundle(b)
    ref = json.loads((d / "reference.json").read_text())
    cams = json.loads((d / "camera-reference.json").read_text())
    mesh = bpy.data.objects.get(L.param("mesh", "body_posed"))
    if mesh is None or mesh.type != "MESH":
        raise RuntimeError("no posed copy: run pose_fit first")
    me = mesh.data
    pts_in = L.param("points") or []
    if len(pts_in) < 2:
        raise RuntimeError('give at least 2 points: [{"name": "eye_L", "px": [u, v], "mm": [x, y, z]}, ...]')
    ref_img = L.param("image")
    if not ref_img:
        raise RuntimeError("image is required (only its size is used)")
    if L.is_id(ref_img) or isinstance(ref_img, dict):
        ip = L.resolve(ref_img, what="image")
    elif str(ref_img).startswith("out:"):
        ip = os.path.join(L.ARGS["out_dir"], str(ref_img)[4:])
    else:
        ip = str(ref_img) if os.path.isabs(str(ref_img)) else str(d / str(ref_img))  # relative to the bundle, as in photo_project
    img = UC.load_image(ip)
    ih, iw = img.shape[:2]
    t = float(L.param("time_s", 0.5))
    cam = camera_for(cams, ref, t, (0, 0), 1.0)
    sx, sy = iw / cam["W"], ih / cam["H"]
    fx, fy = cam["fx"] * sx, cam["fy"] * sy
    cx, cy = cam["cx"] * sx, cam["cy"] * sy
    st = L.param("start") or {}
    s_shift = np.array(st.get("shift", [0, 0]), float)
    if st.get("shift_space", "image") == "proxy":
        s_shift = s_shift * [sx, sy]
    s_k = float(st.get("focal_scale", 1.0))
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    P, px, wts, names = [], [], [], []
    U = P3 = None
    for i, p in enumerate(pts_in):
        names.append(p.get("name", f"p{i}"))
        px.append(p["px"])
        wts.append(float(p.get("weight", 1.0)))
        if "mm" in p:
            P.append(np.array(p["mm"], float) / 1000)
        elif "vertex" in p:
            P.append(np.array(me.vertices[int(p["vertex"])].co[:]))
        elif "uv" in p:
            if U is None:
                if uvn is None or uvn not in me.uv_layers:
                    raise RuntimeError(f"no such UV layer; the layers are {', '.join(u.name for u in me.uv_layers)}")
                tv, P3, U, tl = UC.uv_arrays(me, uvn)
            P.append(uv_to_point(U, P3, p["uv"]))
        else:
            raise RuntimeError(f"point {names[-1]}: give mm, uv or vertex")
    P, px, wts = np.array(P), np.array(px, float), np.array(wts)
    pc = (P - cam["pos"]) @ cam["ax"]
    ax_, ay_ = pc[:, 0] / pc[:, 2], pc[:, 1] / pc[:, 2]  # the normalised image coordinates of each point
    if (pc[:, 2] <= 0.05).any():
        raise RuntimeError("a point is behind the camera or too close to it: check its coordinates (mm, reference frame)")

    def proj(k, sh):
        return np.stack([k * fx * ax_ + cx + sh[0], k * fy * ay_ + cy + sh[1]], 1)
    before = proj(s_k, s_shift)

    def solve(fix_k):
        # unknowns (k?, dx, dy): u = k*fx*ax + cx + dx ; v = k*fy*ay + cy + dy
        rows, rhs, rw = [], [], []
        for i in range(len(P)):
            if fix_k:
                rows += [[1, 0], [0, 1]]
                rhs += [px[i, 0] - (s_k * fx * ax_[i] + cx), px[i, 1] - (s_k * fy * ay_[i] + cy)]
            else:
                rows += [[fx * ax_[i], 1, 0], [fy * ay_[i], 0, 1]]
                rhs += [px[i, 0] - cx, px[i, 1] - cy]
            rw += [wts[i], wts[i]]
        A, y, w = np.array(rows, float), np.array(rhs, float), np.sqrt(np.array(rw))
        sol = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)[0]
        return (s_k, sol[0], sol[1]) if fix_k else (sol[0], sol[1], sol[2])

    def report(k, sh):
        pr = proj(k, sh)
        res = pr - px
        return pr, res, float(np.sqrt((res ** 2).sum(1).mean()))
    k1, dx1, dy1 = solve(True)
    k2, dx2, dy2 = solve(False) if L.param("solve", "both") == "both" else (k1, dx1, dy1)
    pr0, res0, rms0 = report(s_k, s_shift)
    pr2, res2, rms2 = report(k2, (dx2, dy2))
    _, _, rms1 = report(k1, (dx1, dy1))
    notes = []
    if abs(k2 - 1) > 0.15:
        notes.append(f"the solved focal scale {k2:.3f} is far from 1: the points may be mislocated, or the photo is not the same frame as the proxy")
    spread = np.linalg.svd(px - px.mean(0), compute_uv=False)
    if len(P) >= 3 and spread[-1] < 0.05 * spread[0]:
        notes.append("the photo points are nearly in a line: the focal scale is poorly determined")
    L.finish({"image_size": [iw, ih], "camera": {"time_s": cam["t"], "fx_px": round(fx, 1), "fy_px": round(fy, 1), "principal_point_px": [round(float(cx), 1), round(float(cy), 1)], "scale_to_image": [round(sx, 4), round(sy, 4)]},
              "points": [{"name": names[i], "model_mm": [round(float(x) * 1000, 1) for x in P[i]], "photo_px": [round(float(x), 1) for x in px[i]], "projected_before_px": [round(float(x), 1) for x in pr0[i]],
                          "residual_before_px": [round(float(x), 1) for x in res0[i]], "projected_after_px": [round(float(x), 1) for x in pr2[i]], "residual_after_px": [round(float(x), 1) for x in res2[i]]} for i in range(len(P))],
              "rms_before_px": round(rms0, 2), "rms_after_px": round(rms2, 2),
              "solved": {"shift_image_px": [round(float(dx2), 1), round(float(dy2), 1)], "focal_scale": round(float(k2), 4)},
              "shift_only": {"shift_image_px": [round(float(dx1), 1), round(float(dy1), 1)], "focal_scale": round(float(k1), 4), "rms_px": round(rms1, 2)},
              "recommend": {"shift": [round(float(dx2), 1), round(float(dy2), 1)], "shift_space": "image", "focal_scale": round(float(k2), 4)}, "notes": notes})


L.run(main)
